package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"
)

type authFlow struct {
	Phone          string
	Environment    string
	DeviceID       string
	AuthMethod     string
	TempToken      string
	AuthToken      string
	FactorVerified bool
	CreatedAt      time.Time
}

type server struct {
	client *http.Client
	flows  map[string]*authFlow
	mu     sync.Mutex
}

func main() {
	s := &server{
		client: &http.Client{Timeout: 20 * time.Second},
		flows:  map[string]*authFlow{},
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/health", s.withCORS(s.health))
	mux.HandleFunc("/api/auth/start", s.withCORS(s.startLogin))
	mux.HandleFunc("/api/auth/verify-otp", s.withCORS(s.verifyOTP))
	mux.HandleFunc("/api/auth/verify-totp", s.withCORS(s.verifyTOTP))
	mux.HandleFunc("/api/auth/verify-mpin", s.withCORS(s.verifyMPIN))
	mux.HandleFunc("/api/auth/session-status", s.withCORS(s.sessionStatus))
	mux.HandleFunc("/api/market/scanner", s.withCORS(s.marketScanner))
	mux.HandleFunc("/api/market/option-chain", s.withCORS(s.optionChain))
	mux.HandleFunc("/api/market/iv-rank", s.withCORS(s.ivRank))
	// MTM Analyzer — thin reverse-proxies to Nubra REST using the caller's session token
	mux.HandleFunc("/api/historical", s.withCORS(s.proxyHistorical))
	mux.HandleFunc("/api/optionchain/", s.withCORS(s.proxyOptionChain))
	mux.HandleFunc("/api/instruments/search", s.withCORS(s.proxyInstrumentsSearch))

	addr := ":" + env("GO_AUTH_PORT", "3002")
	log.Printf("Go Nubra auth server running on http://localhost%s", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatal(err)
	}
}

func (s *server) withCORS(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if isAllowedOrigin(origin) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
		}
		w.Header().Set("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type,x-session-token,x-device-id,x-raw-cookie")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next(w, r)
	}
}

func (s *server) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *server) startLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"detail": "method not allowed"})
		return
	}
	var req struct {
		Phone       string `json:"phone"`
		Environment string `json:"environment"`
		AuthMethod  string `json:"auth_method"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"detail": "invalid JSON body"})
		return
	}

	phone := digits(req.Phone)
	if len(phone) < 10 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"detail": "Enter a valid Nubra phone number."})
		return
	}
	environment := normalizeEnv(req.Environment)
	authMethod := "otp"
	if req.AuthMethod == "totp" {
		authMethod = "totp"
	}
	flowID := randomID()
	deviceID := "Nubra-OSS-" + phone

	if authMethod == "totp" {
		s.saveFlow(flowID, &authFlow{
			Phone: phone, Environment: environment, DeviceID: deviceID,
			AuthMethod: authMethod, CreatedAt: time.Now(),
		})
		writeJSON(w, http.StatusOK, map[string]any{
			"flow_id": flowID, "next_step": "totp", "masked_phone": maskPhone(phone),
			"environment": environment, "device_id": deviceID,
			"message": "TOTP mode enabled. Enter your authenticator code, then continue to MPIN verification.",
		})
		return
	}

	baseURL := nubraBaseURL(environment)
	first, status, err := s.nubraJSON(r.Context(), http.MethodPost, baseURL+"/sendphoneotp", map[string]string{
		"Content-Type": "application/json",
	}, map[string]any{"phone": phone, "skip_totp": false})
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"detail": "Unable to reach Nubra auth service: " + err.Error()})
		return
	}
	if status >= 400 {
		writeJSON(w, status, map[string]string{"detail": extractError(first, status)})
		return
	}
	tempToken := findString(first, "temp_token", 4)
	if tempToken == "" {
		writeJSON(w, http.StatusBadGateway, map[string]string{"detail": "Nubra did not return a temp token."})
		return
	}

	second, status, err := s.nubraJSON(r.Context(), http.MethodPost, baseURL+"/sendphoneotp", map[string]string{
		"Content-Type": "application/json",
		"x-temp-token": tempToken,
		"x-device-id":  deviceID,
	}, map[string]any{"phone": phone, "skip_totp": true})
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"detail": "Unable to reach Nubra auth service: " + err.Error()})
		return
	}
	if status >= 400 {
		writeJSON(w, status, map[string]string{"detail": extractError(second, status)})
		return
	}
	if nextTemp := findString(second, "temp_token", 4); nextTemp != "" {
		tempToken = nextTemp
	}

	s.saveFlow(flowID, &authFlow{
		Phone: phone, Environment: environment, DeviceID: deviceID,
		AuthMethod: authMethod, TempToken: tempToken, CreatedAt: time.Now(),
	})
	writeJSON(w, http.StatusOK, map[string]any{
		"flow_id": flowID, "next_step": "otp", "masked_phone": maskPhone(phone),
		"environment": environment, "device_id": deviceID,
		"message": "OTP sent. Verify the SMS OTP, then continue to MPIN verification.",
	})
}

func (s *server) verifyOTP(w http.ResponseWriter, r *http.Request) {
	var req struct {
		FlowID string `json:"flow_id"`
		OTP    string `json:"otp"`
	}
	if !s.decodePost(w, r, &req) {
		return
	}
	flow := s.getFlow(req.FlowID)
	if flow == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"detail": "Login flow not found."})
		return
	}
	if flow.AuthMethod != "otp" {
		writeJSON(w, http.StatusConflict, map[string]string{"detail": "This login flow is configured for TOTP."})
		return
	}
	if !isNumeric(req.OTP) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"detail": "OTP must be numeric."})
		return
	}

	payload, status, err := s.nubraJSON(r.Context(), http.MethodPost, nubraBaseURL(flow.Environment)+"/verifyphoneotp", map[string]string{
		"Content-Type": "application/json",
		"x-temp-token": flow.TempToken,
		"x-device-id":  flow.DeviceID,
	}, map[string]any{"phone": flow.Phone, "otp": req.OTP})
	s.finishFactor(w, req.FlowID, flow, payload, status, err, "OTP")
}

func (s *server) verifyTOTP(w http.ResponseWriter, r *http.Request) {
	var req struct {
		FlowID string `json:"flow_id"`
		TOTP   string `json:"totp"`
	}
	if !s.decodePost(w, r, &req) {
		return
	}
	flow := s.getFlow(req.FlowID)
	if flow == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"detail": "Login flow not found."})
		return
	}
	if flow.AuthMethod != "totp" {
		writeJSON(w, http.StatusConflict, map[string]string{"detail": "This login flow is configured for SMS OTP."})
		return
	}
	if !isNumeric(req.TOTP) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"detail": "TOTP must be numeric."})
		return
	}

	payload, status, err := s.nubraJSON(r.Context(), http.MethodPost, nubraBaseURL(flow.Environment)+"/totp/login", map[string]string{
		"Content-Type": "application/json",
		"x-device-id":  flow.DeviceID,
	}, map[string]any{"phone": flow.Phone, "totp": toInt(req.TOTP)})
	s.finishFactor(w, req.FlowID, flow, payload, status, err, "TOTP")
}

func (s *server) finishFactor(w http.ResponseWriter, flowID string, flow *authFlow, payload map[string]any, status int, err error, label string) {
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"detail": "Unable to reach Nubra auth service: " + err.Error()})
		return
	}
	if status >= 400 {
		writeJSON(w, status, map[string]string{"detail": extractError(payload, status)})
		return
	}
	authToken := findString(payload, "auth_token", 4)
	if authToken == "" {
		writeJSON(w, http.StatusBadGateway, map[string]string{"detail": fmt.Sprintf("Nubra did not return auth_token after %s verification.", label)})
		return
	}
	s.mu.Lock()
	flow.AuthToken = authToken
	flow.FactorVerified = true
	s.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"flow_id": flowID, "next_step": "mpin", "message": label + " accepted. Continue with MPIN verification."})
}

func (s *server) verifyMPIN(w http.ResponseWriter, r *http.Request) {
	var req struct {
		FlowID string `json:"flow_id"`
		MPIN   string `json:"mpin"`
	}
	if !s.decodePost(w, r, &req) {
		return
	}
	flow := s.getFlow(req.FlowID)
	if flow == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"detail": "Login flow not found."})
		return
	}
	if !flow.FactorVerified || flow.AuthToken == "" {
		writeJSON(w, http.StatusConflict, map[string]string{"detail": "OTP or TOTP must be verified first."})
		return
	}
	if !isNumeric(req.MPIN) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"detail": "MPIN must be numeric."})
		return
	}

	baseURL := nubraBaseURL(flow.Environment)
	payload, status, err := s.nubraJSON(r.Context(), http.MethodPost, baseURL+"/verifypin", map[string]string{
		"Content-Type":  "application/json",
		"Authorization": "Bearer " + flow.AuthToken,
		"x-device-id":   flow.DeviceID,
	}, map[string]any{"pin": req.MPIN})
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"detail": "Unable to reach Nubra auth service: " + err.Error()})
		return
	}
	if status >= 400 {
		writeJSON(w, status, map[string]string{"detail": extractError(payload, status)})
		return
	}
	sessionToken := firstNonEmpty(findString(payload, "session_token", 4), findString(payload, "token", 4))
	if sessionToken == "" {
		writeJSON(w, http.StatusBadGateway, map[string]string{"detail": "Nubra did not return session_token after MPIN verification."})
		return
	}

	accountID := s.fetchClientCode(r.Context(), baseURL, sessionToken, flow.DeviceID)
	if accountID == "" {
		accountID = "NUBRA-" + flow.Phone[len(flow.Phone)-4:]
	}
	s.deleteFlow(req.FlowID)

	writeJSON(w, http.StatusOK, map[string]any{
		"access_token": sessionToken, "refresh_token": randomID(),
		"user_name": "Nubra User", "account_id": accountID, "device_id": flow.DeviceID,
		"environment": flow.Environment, "broker": "Nubra", "expires_in": 3600,
		"message": "Nubra session established using the REST API login flow.",
	})
}

func (s *server) sessionStatus(w http.ResponseWriter, r *http.Request) {
	var req struct {
		SessionToken string `json:"session_token"`
		DeviceID     string `json:"device_id"`
		Environment  string `json:"environment"`
	}
	if !s.decodePost(w, r, &req) {
		return
	}
	if req.SessionToken == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"detail": "session_token is required."})
		return
	}
	if req.DeviceID == "" {
		req.DeviceID = "web"
	}
	environment := normalizeEnv(req.Environment)
	baseURL := nubraBaseURL(environment)
	payload, status, err := s.nubraJSON(r.Context(), http.MethodGet, baseURL+"/userinfo", map[string]string{
		"Authorization": "Bearer " + req.SessionToken,
		"x-device-id":   req.DeviceID,
		"Accept":        "application/json",
	}, nil)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"detail": "Unable to reach Nubra auth service: " + err.Error()})
		return
	}
	if status == http.StatusUnauthorized || status == http.StatusForbidden || status == 440 {
		writeJSON(w, http.StatusOK, map[string]any{"active": false, "environment": environment, "expires_at_utc": nil, "account_id": nil, "message": extractError(payload, status)})
		return
	}
	if status >= 400 {
		writeJSON(w, status, map[string]string{"detail": extractError(payload, status)})
		return
	}
	accountID := s.fetchClientCode(r.Context(), baseURL, req.SessionToken, req.DeviceID)
	writeJSON(w, http.StatusOK, map[string]any{"active": true, "environment": environment, "expires_at_utc": nil, "account_id": nullableString(accountID), "message": "Session is active."})
}

func (s *server) decodePost(w http.ResponseWriter, r *http.Request, dest any) bool {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"detail": "method not allowed"})
		return false
	}
	if err := decodeJSON(r, dest); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"detail": "invalid JSON body"})
		return false
	}
	return true
}

func (s *server) nubraJSON(ctx context.Context, method, url string, headers map[string]string, body any) (map[string]any, int, error) {
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return nil, 0, err
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, url, reader)
	if err != nil {
		return nil, 0, err
	}
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	res, err := s.client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, res.StatusCode, err
	}
	var payload map[string]any
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &payload); err != nil {
			payload = map[string]any{"_raw": string(raw)}
		}
	} else {
		payload = map[string]any{}
	}
	return payload, res.StatusCode, nil
}

func (s *server) fetchClientCode(ctx context.Context, baseURL, sessionToken, deviceID string) string {
	paths := []string{"portfolio/user_funds_and_margin", "portfolio/v2/positions", "portfolio/holdings", "userinfo"}
	for _, path := range paths {
		payload, status, err := s.nubraJSON(ctx, http.MethodGet, baseURL+"/"+path, map[string]string{
			"Authorization": "Bearer " + sessionToken,
			"Content-Type":  "application/json",
			"Accept":        "application/json",
			"x-device-id":   deviceID,
		}, nil)
		if err == nil && status < 400 {
			if code := findString(payload, "client_code", 4); code != "" {
				return code
			}
		}
	}
	return ""
}

func (s *server) saveFlow(id string, flow *authFlow) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cleanupLocked()
	s.flows[id] = flow
}

func (s *server) getFlow(id string) *authFlow {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cleanupLocked()
	return s.flows[id]
}

func (s *server) deleteFlow(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.flows, id)
}

func (s *server) cleanupLocked() {
	cutoff := time.Now().Add(-15 * time.Minute)
	for id, flow := range s.flows {
		if flow.CreatedAt.Before(cutoff) {
			delete(s.flows, id)
		}
	}
}

func decodeJSON(r *http.Request, dest any) error {
	defer r.Body.Close()
	return json.NewDecoder(r.Body).Decode(dest)
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func nubraBaseURL(environment string) string {
	if strings.ToUpper(environment) == "UAT" {
		return env("NUBRA_UAT_BASE_URL", "https://uat-api.nubra.io")
	}
	return env("NUBRA_PROD_BASE_URL", "https://api.nubra.io")
}

func normalizeEnv(value string) string {
	if strings.ToUpper(value) == "UAT" {
		return "UAT"
	}
	return "PROD"
}

func env(key, fallback string) string {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	return strings.TrimRight(value, "/")
}

func digits(value string) string {
	re := regexp.MustCompile(`\D+`)
	return re.ReplaceAllString(value, "")
}

func isNumeric(value string) bool {
	return regexp.MustCompile(`^\d+$`).MatchString(value)
}

func toInt(value string) int {
	var n int
	for _, ch := range value {
		n = n*10 + int(ch-'0')
	}
	return n
}

func maskPhone(phone string) string {
	if len(phone) < 4 {
		return phone
	}
	return phone[:2] + "******" + phone[len(phone)-2:]
}

func randomID() string {
	buf := make([]byte, 18)
	if _, err := rand.Read(buf); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return base64.RawURLEncoding.EncodeToString(buf)
}

func extractError(payload map[string]any, status int) string {
	for _, key := range []string{"message", "detail", "error"} {
		if value := findString(payload, key, 4); value != "" {
			return value
		}
	}
	return fmt.Sprintf("Nubra request failed with status %d.", status)
}

func findString(value any, fieldName string, depth int) string {
	if depth < 0 || value == nil {
		return ""
	}
	switch typed := value.(type) {
	case map[string]any:
		if raw, ok := typed[fieldName]; ok {
			if str, ok := raw.(string); ok && strings.TrimSpace(str) != "" {
				return strings.TrimSpace(str)
			}
		}
		for _, nested := range typed {
			if found := findString(nested, fieldName, depth-1); found != "" {
				return found
			}
		}
	case []any:
		for _, nested := range typed {
			if found := findString(nested, fieldName, depth-1); found != "" {
				return found
			}
		}
	}
	return ""
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func nullableString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

// ── MARKET SCANNER ──────────────────────────────────────────────────────────

// scannerSymbols — verified against the Nifty300 universe CSV used by Nubra refdata.
var scannerSymbols = []string{
	"HDFCBANK", "INFY", "ICICIBANK", "KOTAKBANK", "AXISBANK",
	"HINDUNILVR", "BAJFINANCE", "BHARTIARTL", "ITC", "ASIANPAINT",
	"CIPLA", "HCLTECH", "ADANIENT", "ADANIPORTS", "COALINDIA",
	"DRREDDY", "HINDALCO", "JSWSTEEL", "APOLLOHOSP", "DMART",
	"BAJAJFINSV", "EICHERMOT", "HEROMOTOCO", "DIVISLAB", "BPCL",
	"GAIL", "HAVELLS", "LT", "BERGEPAINT", "ICICIPRULI",
}

type scannerRequest struct {
	SessionToken string `json:"session_token"`
	DeviceID     string `json:"device_id"`
	Environment  string `json:"environment"`
}

type scannerRow struct {
	Rank           int     `json:"rank"`
	Symbol         string  `json:"symbol"`
	DisplayName    string  `json:"display_name"`
	Exchange       string  `json:"exchange"`
	LastPrice      float64 `json:"last_price"`
	CurrentVolume  int64   `json:"current_volume"`
	AverageVolume  int64   `json:"average_volume"`
	VolumeRatio    float64 `json:"volume_ratio"`
	PriceChangePct float64 `json:"price_change_pct"`
	IsGreen        bool    `json:"is_green"`
}

type scannerResponse struct {
	Status  string       `json:"status"`
	Message string       `json:"message"`
	Rows    []scannerRow `json:"rows"`
}

// timeseriesPayload mirrors the Nubra /charts/timeseries request body.
// intraDay must be false when fetching historical windows; true means "current day only".
func timeseriesPayload(symbols []string, exchange, interval, startDate, endDate string) map[string]any {
	return map[string]any{
		"query": []any{
			map[string]any{
				"exchange":  exchange,
				"type":      "STOCK",
				"values":    symbols,
				"fields":    []string{"open", "close", "cumulative_volume"},
				"startDate": startDate,
				"endDate":   endDate,
				"interval":  interval,
				"intraDay":  false,
				"realTime":  false,
			},
		},
	}
}

func (s *server) marketScanner(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"detail": "method not allowed"})
		return
	}
	var req scannerRequest
	if err := decodeJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"detail": "invalid JSON body"})
		return
	}
	if req.SessionToken == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"detail": "session_token is required"})
		return
	}
	if req.DeviceID == "" {
		req.DeviceID = "Nubra-OSS-scanner"
	}

	baseURL := nubraBaseURL(req.Environment)
	now := time.Now().In(time.FixedZone("IST", 5*3600+30*60))

	// Fetch 2 days of 5m bars: yesterday open to now, so we have prior-day baseline.
	start := now.AddDate(0, 0, -2).Format("2006-01-02") + "T03:30:00.000Z" // ~IST 09:00 D-2
	end := now.UTC().Format("2006-01-02T15:04:05.000Z")

	// Fetch in batches of 5 (Nubra documented limit per request).
	type symbolData struct {
		candles []struct{ ts int64; open, close, cumVol float64 }
	}
	allData := map[string]symbolData{}

	for i := 0; i < len(scannerSymbols); i += 5 {
		end2 := i + 5
		if end2 > len(scannerSymbols) {
			end2 = len(scannerSymbols)
		}
		batch := scannerSymbols[i:end2]

		body := timeseriesPayload(batch, "NSE", "5m", start, end)
		payload, status, err := s.nubraJSON(r.Context(), http.MethodPost, baseURL+"/charts/timeseries",
			map[string]string{
				"Authorization": "Bearer " + req.SessionToken,
				"Content-Type":  "application/json",
				"Accept":        "application/json",
				"x-device-id":   req.DeviceID,
			}, body)
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"detail": "Nubra timeseries error: " + err.Error()})
			return
		}
		if status >= 400 {
			writeJSON(w, status, map[string]string{"detail": extractError(payload, status)})
			return
		}

		// Parse Nubra response: result[].values[]{symbol: {open:[{ts,v}], close:[...], cumulative_volume:[...]}}
		results, _ := payload["result"].([]any)
		for _, resultItem := range results {
			ri, _ := resultItem.(map[string]any)
			values, _ := ri["values"].([]any)
			for _, stockEntry := range values {
				se, _ := stockEntry.(map[string]any)
				for sym, symChart := range se {
					sc, _ := symChart.(map[string]any)
					openPts, _ := sc["open"].([]any)
					closePts, _ := sc["close"].([]any)
					cumVolPts, _ := sc["cumulative_volume"].([]any)

					// Build a map ts->cumVol for easy lookup.
					type pt struct{ ts int64; v float64 }
					toPoints := func(arr []any) []pt {
						out := make([]pt, 0, len(arr))
						for _, item := range arr {
							m, _ := item.(map[string]any)
							ts, _ := m["ts"].(float64)
							v, _ := m["v"].(float64)
							out = append(out, pt{int64(ts), v})
						}
						return out
					}
					openPoints := toPoints(openPts)
					closePoints := toPoints(closePts)
					cumVolPoints := toPoints(cumVolPts)

					// Align by index (Nubra returns same-length parallel arrays).
					n := len(openPoints)
					if n > len(closePoints) { n = len(closePoints) }
					if n > len(cumVolPoints) { n = len(cumVolPoints) }

					type candle struct{ ts int64; open, close, cumVol float64 }
					candles := make([]candle, n)
					for idx := 0; idx < n; idx++ {
						candles[idx] = candle{
							ts:     openPoints[idx].ts,
							open:   openPoints[idx].v / 100.0,
							close:  closePoints[idx].v / 100.0,
							cumVol: cumVolPoints[idx].v,
						}
					}

					// Derive per-bucket volume from cumulative.
					bucketVols := make([]float64, n)
					for idx := 0; idx < n; idx++ {
						if idx == 0 {
							bucketVols[idx] = candles[idx].cumVol
						} else {
							diff := candles[idx].cumVol - candles[idx-1].cumVol
							if diff < 0 { diff = candles[idx].cumVol } // new session reset
							bucketVols[idx] = diff
						}
					}

					type sd struct{ candles []struct{ ts int64; open, close, cumVol float64 } }
					_ = sd{}

					allData[strings.ToUpper(sym)] = symbolData{
						candles: func() []struct{ ts int64; open, close, cumVol float64 } {
							out := make([]struct{ ts int64; open, close, cumVol float64 }, n)
							for idx := 0; idx < n; idx++ {
								out[idx] = struct{ ts int64; open, close, cumVol float64 }{
									candles[idx].ts, candles[idx].open, candles[idx].close, bucketVols[idx],
								}
							}
							return out
						}(),
					}
				}
			}
		}
	}

	// Build scanner rows: compare latest candle volume to average of same candle-index on prior days.
	nowNano := now.UnixNano()
	// IST midnight today in nanoseconds.
	todayMidnightIST := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location()).UnixNano()

	rows := make([]scannerRow, 0, len(scannerSymbols))
	for _, sym := range scannerSymbols {
		data, ok := allData[sym]
		if !ok || len(data.candles) == 0 {
			continue
		}

		// Split into today vs prior candles.
		var todayCandles, priorCandles []struct{ ts int64; open, close, cumVol float64 }
		for _, c := range data.candles {
			if c.ts >= todayMidnightIST {
				todayCandles = append(todayCandles, c)
			} else {
				priorCandles = append(priorCandles, c)
			}
		}
		if len(todayCandles) == 0 {
			continue
		}

		// Current candle = last today candle. Check it's within last 15 minutes.
		latest := todayCandles[len(todayCandles)-1]
		if nowNano-latest.ts > int64(15*time.Minute) {
			// Stale — skip.
			continue
		}

		currentVol := latest.cumVol // already bucket vol
		currentIdx := len(todayCandles) - 1

		// Average volume of same candle index on prior days.
		var avgVol float64
		if len(priorCandles) > 0 && currentIdx < len(priorCandles) {
			// Use same slot from prior day as a rough baseline.
			// Group prior candles by day and pick the candle at same index.
			const candlesPerDay = 75 // ~375 min / 5 min
			avgSamples := 0
			totalVol := 0.0
			for dayStart := 0; dayStart+currentIdx < len(priorCandles); dayStart += candlesPerDay {
				idx := dayStart + currentIdx
				if idx < len(priorCandles) {
					totalVol += priorCandles[idx].cumVol
					avgSamples++
				}
			}
			if avgSamples > 0 {
				avgVol = totalVol / float64(avgSamples)
			}
		}
		if avgVol < 1000 {
			avgVol = 1000 // floor to avoid division noise
		}

		ratio := currentVol / avgVol
		if ratio < 1.5 {
			continue // not a breakout
		}

		ltp := latest.close
		open := todayCandles[0].open
		pctChange := 0.0
		if open > 0 {
			pctChange = (ltp - open) / open * 100
		}

		rows = append(rows, scannerRow{
			Symbol:         sym,
			DisplayName:    sym,
			Exchange:       "NSE",
			LastPrice:      ltp,
			CurrentVolume:  int64(currentVol),
			AverageVolume:  int64(avgVol),
			VolumeRatio:    ratio,
			PriceChangePct: pctChange,
			IsGreen:        ltp >= open,
		})
	}

	// Sort by volume ratio descending and assign ranks.
	for i := 0; i < len(rows); i++ {
		for j := i + 1; j < len(rows); j++ {
			if rows[j].VolumeRatio > rows[i].VolumeRatio {
				rows[i], rows[j] = rows[j], rows[i]
			}
		}
	}
	for i := range rows {
		rows[i].Rank = i + 1
	}

	msg := fmt.Sprintf("Volume scanner found %d breakout(s) across %d symbols.", len(rows), len(scannerSymbols))
	if len(rows) == 0 {
		msg = "No volume breakouts detected right now. Market may be closed or volume is below the 1.5× threshold."
	}
	writeJSON(w, http.StatusOK, scannerResponse{Status: "success", Message: msg, Rows: rows})
}

// ── OPTION CHAIN ────────────────────────────────────────────────────────────

type optionChainRequest struct {
	SessionToken string `json:"session_token"`
	DeviceID     string `json:"device_id"`
	Environment  string `json:"environment"`
	Instrument   string `json:"instrument"` // e.g. "NIFTY"
	Expiry       string `json:"expiry"`     // e.g. "20250626" — empty = nearest
}

type optionLeg struct {
	RefID          int     `json:"ref_id"`
	Strike         float64 `json:"strike"`   // paise → div by 100 for display
	LTP            float64 `json:"ltp"`      // paise → div by 100
	LTPChange      float64 `json:"ltp_chg"`
	IV             float64 `json:"iv"`
	Delta          float64 `json:"delta"`
	Gamma          float64 `json:"gamma"`
	Theta          float64 `json:"theta"`
	Vega           float64 `json:"vega"`
	OI             int64   `json:"oi"`
	OIChange       float64 `json:"oi_chg"`
	Volume         int64   `json:"volume"`
}

type optionChainResponse struct {
	Instrument  string      `json:"instrument"`
	Expiry      string      `json:"expiry"`
	AllExpiries []string    `json:"all_expiries"`
	ATM         float64     `json:"atm"`
	CurrentPrice float64    `json:"current_price"`
	CE          []optionLeg `json:"ce"`
	PE          []optionLeg `json:"pe"`
	PCR         float64     `json:"pcr"`
	TotalCEOI   int64       `json:"total_ce_oi"`
	TotalPEOI   int64       `json:"total_pe_oi"`
}

func (s *server) optionChain(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"detail": "method not allowed"})
		return
	}
	var req optionChainRequest
	if err := decodeJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"detail": "invalid JSON"})
		return
	}
	if req.SessionToken == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"detail": "session_token required"})
		return
	}
	if req.DeviceID == "" {
		req.DeviceID = "Nubra-OSS-desk"
	}
	if req.Instrument == "" {
		req.Instrument = "NIFTY"
	}

	baseURL := nubraBaseURL(req.Environment)
	url := baseURL + "/optionchains/" + req.Instrument + "?exchange=NSE"
	if req.Expiry != "" {
		url += "&expiry=" + req.Expiry
	}

	payload, status, err := s.nubraJSON(r.Context(), http.MethodGet, url, map[string]string{
		"Authorization": "Bearer " + req.SessionToken,
		"Accept":        "application/json",
		"x-device-id":   req.DeviceID,
	}, nil)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"detail": err.Error()})
		return
	}
	if status >= 400 {
		writeJSON(w, status, map[string]string{"detail": extractError(payload, status)})
		return
	}

	chain, _ := payload["chain"].(map[string]any)
	if chain == nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"detail": "unexpected response from Nubra"})
		return
	}

	parseLeg := func(item map[string]any) optionLeg {
		asFloat := func(v any) float64 {
			switch x := v.(type) {
			case float64:
				return x
			case int64:
				return float64(x)
			}
			return 0
		}
		asInt64 := func(v any) int64 {
			switch x := v.(type) {
			case float64:
				return int64(x)
			case int64:
				return x
			}
			return 0
		}
		return optionLeg{
			RefID:     int(asInt64(item["ref_id"])),
			Strike:    asFloat(item["sp"]) / 100.0,
			LTP:       asFloat(item["ltp"]) / 100.0,
			LTPChange: asFloat(item["ltpchg"]),
			IV:        asFloat(item["iv"]),
			Delta:     asFloat(item["delta"]),
			Gamma:     asFloat(item["gamma"]),
			Theta:     asFloat(item["theta"]),
			Vega:      asFloat(item["vega"]),
			OI:        asInt64(item["oi"]),
			OIChange:  asFloat(item["oi_chg"]),
			Volume:    asInt64(item["volume"]),
		}
	}

	parseLegs := func(arr []any) []optionLeg {
		out := make([]optionLeg, 0, len(arr))
		for _, item := range arr {
			m, ok := item.(map[string]any)
			if !ok {
				continue
			}
			out = append(out, parseLeg(m))
		}
		return out
	}

	ceArr, _ := chain["ce"].([]any)
	peArr, _ := chain["pe"].([]any)
	ceLegs := parseLegs(ceArr)
	peLegs := parseLegs(peArr)

	var totalCEOI, totalPEOI int64
	for _, l := range ceLegs {
		totalCEOI += l.OI
	}
	for _, l := range peLegs {
		totalPEOI += l.OI
	}
	pcr := 0.0
	if totalCEOI > 0 {
		pcr = float64(totalPEOI) / float64(totalCEOI)
	}

	atm, _ := chain["atm"].(float64)
	cp, _ := chain["cp"].(float64)
	expiry, _ := chain["expiry"].(string)

	allExpiriesRaw, _ := chain["all_expiries"].([]any)
	allExpiries := make([]string, 0, len(allExpiriesRaw))
	for _, e := range allExpiriesRaw {
		if s, ok := e.(string); ok {
			allExpiries = append(allExpiries, s)
		}
	}

	writeJSON(w, http.StatusOK, optionChainResponse{
		Instrument:   req.Instrument,
		Expiry:       expiry,
		AllExpiries:  allExpiries,
		ATM:          atm / 100.0,
		CurrentPrice: cp / 100.0,
		CE:           ceLegs,
		PE:           peLegs,
		PCR:          pcr,
		TotalCEOI:    totalCEOI,
		TotalPEOI:    totalPEOI,
	})
}

// ── IV RANK ──────────────────────────────────────────────────────────────────

type ivRankRequest struct {
	SessionToken string `json:"session_token"`
	DeviceID     string `json:"device_id"`
	Environment  string `json:"environment"`
	Instrument   string `json:"instrument"`
	Expiry       string `json:"expiry"`
}

type ivRankResponse struct {
	Instrument string  `json:"instrument"`
	IVRank     float64 `json:"iv_rank"`     // 0–100
	IVPercent  float64 `json:"iv_percent"`  // current ATM IV as %
	IVHigh52   float64 `json:"iv_high_52"`
	IVLow52    float64 `json:"iv_low_52"`
	Message    string  `json:"message"`
}

func (s *server) ivRank(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"detail": "method not allowed"})
		return
	}
	var req ivRankRequest
	if err := decodeJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"detail": "invalid JSON"})
		return
	}
	if req.SessionToken == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"detail": "session_token required"})
		return
	}
	if req.DeviceID == "" {
		req.DeviceID = "Nubra-OSS-desk"
	}
	if req.Instrument == "" {
		req.Instrument = "NIFTY"
	}

	baseURL := nubraBaseURL(req.Environment)

	// Step 1: get current ATM IV from the option chain snapshot.
	chainURL := baseURL + "/optionchains/" + req.Instrument + "?exchange=NSE"
	if req.Expiry != "" {
		chainURL += "&expiry=" + req.Expiry
	}
	chainPayload, status, err := s.nubraJSON(r.Context(), http.MethodGet, chainURL, map[string]string{
		"Authorization": "Bearer " + req.SessionToken,
		"Accept":        "application/json",
		"x-device-id":   req.DeviceID,
	}, nil)
	if err != nil || status >= 400 {
		writeJSON(w, http.StatusBadGateway, map[string]string{"detail": "option chain fetch failed"})
		return
	}

	chain, _ := chainPayload["chain"].(map[string]any)
	atm, _ := chain["atm"].(float64)
	ceArr, _ := chain["ce"].([]any)
	peArr, _ := chain["pe"].([]any)

	// Find ATM CE and PE IV.
	currentIV := 0.0
	findATMIV := func(arr []any) float64 {
		for _, item := range arr {
			m, ok := item.(map[string]any)
			if !ok {
				continue
			}
			sp, _ := m["sp"].(float64)
			if sp == atm {
				iv, _ := m["iv"].(float64)
				return iv
			}
		}
		return 0
	}
	ceIV := findATMIV(ceArr)
	peIV := findATMIV(peArr)
	if ceIV > 0 && peIV > 0 {
		currentIV = (ceIV + peIV) / 2.0
	} else if ceIV > 0 {
		currentIV = ceIV
	} else {
		currentIV = peIV
	}

	// Step 2: fetch 1-year daily option history to compute 52-week IV high/low.
	// We use ATM CE symbol constructed from option chain or fall back to NIFTY index history.
	// Use index IV_MID from historical data as proxy (1d interval, 1 year).
	now := time.Now().UTC()
	histStart := now.AddDate(-1, 0, 0).Format("2006-01-02") + "T03:30:00.000Z"
	histEnd := now.Format("2006-01-02T15:04:05.000Z")

	// Use iv_mid on the index as a 52-week IV proxy.
	histBody := map[string]any{
		"query": []any{
			map[string]any{
				"exchange":  "NSE",
				"type":      "INDEX",
				"values":    []string{req.Instrument},
				"fields":    []string{"iv_mid"},
				"startDate": histStart,
				"endDate":   histEnd,
				"interval":  "1d",
				"intraDay":  false,
				"realTime":  false,
			},
		},
	}
	histPayload, histStatus, histErr := s.nubraJSON(r.Context(), http.MethodPost, baseURL+"/charts/timeseries",
		map[string]string{
			"Authorization": "Bearer " + req.SessionToken,
			"Content-Type":  "application/json",
			"Accept":        "application/json",
			"x-device-id":   req.DeviceID,
		}, histBody)

	ivHigh, ivLow, ivRankVal := 0.0, 0.0, 0.0
	msg := "IV Rank computed from 52-week daily IV history."

	if histErr == nil && histStatus < 400 {
		results, _ := histPayload["result"].([]any)
		var ivSeries []float64
		for _, ri := range results {
			rim, _ := ri.(map[string]any)
			vals, _ := rim["values"].([]any)
			for _, ve := range vals {
				vem, _ := ve.(map[string]any)
				for _, symData := range vem {
					sdm, _ := symData.(map[string]any)
					ivMidArr, _ := sdm["iv_mid"].([]any)
					for _, pt := range ivMidArr {
						ptm, _ := pt.(map[string]any)
						v, _ := ptm["v"].(float64)
						if v > 0 {
							ivSeries = append(ivSeries, v)
						}
					}
				}
			}
		}
		if len(ivSeries) > 0 {
			ivHigh = ivSeries[0]
			ivLow = ivSeries[0]
			for _, v := range ivSeries {
				if v > ivHigh {
					ivHigh = v
				}
				if v < ivLow {
					ivLow = v
				}
			}
			if ivHigh > ivLow && currentIV > 0 {
				ivRankVal = (currentIV - ivLow) / (ivHigh - ivLow) * 100.0
			}
		} else {
			msg = "IV history returned no data — rank estimated from current IV only."
		}
	} else {
		msg = "IV history unavailable — showing current IV only."
	}

	writeJSON(w, http.StatusOK, ivRankResponse{
		Instrument: req.Instrument,
		IVRank:     ivRankVal,
		IVPercent:  currentIV * 100.0,
		IVHigh52:   ivHigh * 100.0,
		IVLow52:    ivLow * 100.0,
		Message:    msg,
	})
}

func isAllowedOrigin(origin string) bool {
	if origin == "" {
		return false
	}
	return origin == "http://localhost:8888" ||
		origin == "http://127.0.0.1:8888" ||
		origin == "http://localhost:8891" ||
		origin == "http://127.0.0.1:8891" ||
		origin == "http://localhost:5173" ||
		origin == "http://127.0.0.1:5173"
}

// ── MTM ANALYZER REVERSE PROXIES ────────────────────────────────────────────
// These three handlers forward MTM Analyzer REST calls to Nubra directly,
// using the Authorization / x-device-id headers supplied by the browser.

// proxyHistorical: POST /api/historical → Nubra POST /charts/timeseries
func (s *server) proxyHistorical(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	body, err := io.ReadAll(r.Body)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "read body: " + err.Error()})
		return
	}
	env := firstNonEmpty(r.Header.Get("x-nubra-env"), "PROD")
	baseURL := nubraBaseURL(env)
	req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, baseURL+"/charts/timeseries", bytes.NewReader(body))
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", r.Header.Get("Authorization"))
	req.Header.Set("x-device-id", firstNonEmpty(r.Header.Get("x-device-id"), "Nubra-OSS-mtm"))
	s.forwardResponse(w, req)
}

// proxyOptionChain: GET /api/optionchain/{symbol}?exchange=NSE&expiry=... → Nubra GET /optionchains/{symbol}?...
func (s *server) proxyOptionChain(w http.ResponseWriter, r *http.Request) {
	symbol := strings.TrimPrefix(r.URL.Path, "/api/optionchain/")
	symbol = strings.Trim(symbol, "/")
	if symbol == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "symbol required"})
		return
	}
	env := firstNonEmpty(r.URL.Query().Get("env"), r.Header.Get("x-nubra-env"), "PROD")
	baseURL := nubraBaseURL(env)
	upstream := baseURL + "/optionchains/" + symbol + "?" + r.URL.RawQuery
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, upstream, nil)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	req.Header.Set("Authorization", r.Header.Get("Authorization"))
	req.Header.Set("x-device-id", firstNonEmpty(r.Header.Get("x-device-id"), "Nubra-OSS-mtm"))
	s.forwardResponse(w, req)
}

// proxyInstrumentsSearch: GET /api/instruments/search?q=...&limit=... → Nubra GET /refdata/search?q=...
func (s *server) proxyInstrumentsSearch(w http.ResponseWriter, r *http.Request) {
	env := firstNonEmpty(r.URL.Query().Get("env"), r.Header.Get("x-nubra-env"), "PROD")
	baseURL := nubraBaseURL(env)
	q := r.URL.Query().Get("q")
	limit := firstNonEmpty(r.URL.Query().Get("limit"), "20")
	upstream := baseURL + "/refdata/search?q=" + q + "&limit=" + limit
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, upstream, nil)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	req.Header.Set("Authorization", r.Header.Get("Authorization"))
	req.Header.Set("x-device-id", firstNonEmpty(r.Header.Get("x-device-id"), "Nubra-OSS-mtm"))
	s.forwardResponse(w, req)
}

// forwardResponse pipes an upstream Nubra response back to the browser.
func (s *server) forwardResponse(w http.ResponseWriter, req *http.Request) {
	resp, err := s.client.Do(req)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	defer resp.Body.Close()
	ct := resp.Header.Get("Content-Type")
	if ct == "" {
		ct = "application/json"
	}
	w.Header().Set("Content-Type", ct)
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}
