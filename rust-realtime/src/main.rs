use std::{net::SocketAddr, sync::Arc, time::{SystemTime, UNIX_EPOCH}};

use anyhow::{anyhow, Context, Result};
use axum::{
    extract::{
        ws::{Message as WsMessage, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    http::{Method, StatusCode},
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use prost::Message;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio_tungstenite::{connect_async, tungstenite};
use tower_http::cors::{Any, CorsLayer};
use tracing::{error, info, warn};

#[derive(Debug, Deserialize)]
struct RealtimeQuery {
    token: String,
    #[serde(default = "default_environment")]
    env: String,
    #[serde(default = "default_instrument")]
    instrument: String,
    #[serde(default = "default_exchange")]
    exchange: String,
    #[serde(default = "default_stream")]
    stream: String,
    expiry: Option<String>,
    /// interval for ohlcv stream, e.g. "1m", "5m", "15m"
    #[serde(default = "default_interval")]
    interval: String,
}

#[derive(Debug, Serialize)]
struct Health {
    status: &'static str,
    service: &'static str,
}

#[derive(Clone, PartialEq, Message)]
struct GenericData {
    #[prost(string, tag = "1")]
    key: String,
    #[prost(message, optional, tag = "2")]
    data: Option<prost_types::Any>,
}

#[derive(Clone, PartialEq, Message, Serialize)]
struct BatchWebSocketIndexMessage {
    #[prost(int64, tag = "1")]
    timestamp: i64,
    #[prost(message, repeated, tag = "2")]
    indexes: Vec<WebSocketMsgIndex>,
    #[prost(message, repeated, tag = "3")]
    instruments: Vec<WebSocketMsgIndex>,
}

#[derive(Clone, PartialEq, Message, Serialize)]
struct WebSocketMsgIndex {
    #[prost(string, tag = "1")]
    indexname: String,
    #[prost(int64, tag = "2")]
    timestamp: i64,
    #[prost(int64, tag = "3")]
    index_value: i64,
    #[prost(int64, tag = "4")]
    high_index_value: i64,
    #[prost(int64, tag = "5")]
    low_index_value: i64,
    #[prost(int64, tag = "6")]
    volume: i64,
    #[prost(float, tag = "7")]
    changepercent: f32,
    #[prost(int64, tag = "8")]
    tick_volume: i64,
    #[prost(int64, tag = "9")]
    prev_close: i64,
    #[prost(string, tag = "10")]
    exchange: String,
    #[prost(int64, tag = "11")]
    volume_oi: i64,
}

// OHLCV candle bucket — from index_bucket stream
#[derive(Clone, PartialEq, Message, Serialize)]
struct BatchWebSocketIndexBucketMessage {
    #[prost(int64, tag = "1")]
    timestamp: i64,
    #[prost(message, repeated, tag = "2")]
    indexes: Vec<WebSocketMsgIndexBucket>,
    #[prost(message, repeated, tag = "3")]
    instruments: Vec<WebSocketMsgIndexBucket>,
}

#[derive(Clone, PartialEq, Message, Serialize)]
struct WebSocketMsgIndexBucket {
    #[prost(string, tag = "1")]
    indexname: String,
    #[prost(string, tag = "2")]
    exchange: String,
    #[prost(int32, tag = "3")]
    interval: i32,
    #[prost(int64, tag = "4")]
    timestamp: i64,
    #[prost(int64, tag = "5")]
    open: i64,
    #[prost(int64, tag = "6")]
    high: i64,
    #[prost(int64, tag = "7")]
    low: i64,
    #[prost(int64, tag = "8")]
    close: i64,
    #[prost(int64, tag = "9")]
    bucket_volume: i64,
    #[prost(int64, tag = "10")]
    tick_volume: i64,
    #[prost(int64, tag = "11")]
    cumulative_volume: i64,
    #[prost(int64, tag = "12")]
    bucket_timestamp: i64,
}

#[derive(Clone, PartialEq, Message, Serialize)]
struct WebSocketMsgOptionChainUpdate {
    #[prost(string, tag = "1")]
    asset: String,
    #[prost(string, tag = "2")]
    expiry: String,
    #[prost(message, repeated, tag = "3")]
    ce: Vec<WebSocketMsgOptionChainItem>,
    #[prost(message, repeated, tag = "4")]
    pe: Vec<WebSocketMsgOptionChainItem>,
    #[prost(int64, tag = "5")]
    atm: i64,
    #[prost(int64, tag = "6")]
    currentprice: i64,
    #[prost(string, tag = "7")]
    exchange: String,
}

#[derive(Clone, PartialEq, Message, Serialize)]
struct WebSocketMsgOptionChainItem {
    #[prost(int64, tag = "1")]
    inst_id: i64,
    #[prost(int64, tag = "2")]
    ts: i64,
    #[prost(int64, tag = "3")]
    sp: i64,
    #[prost(int32, tag = "4")]
    ls: i32,
    #[prost(int64, tag = "5")]
    ltp: i64,
    #[prost(float, tag = "6")]
    ltpchg: f32,
    #[prost(float, tag = "7")]
    iv: f32,
    #[prost(float, tag = "8")]
    delta: f32,
    #[prost(float, tag = "9")]
    gamma: f32,
    #[prost(float, tag = "10")]
    theta: f32,
    #[prost(float, tag = "11")]
    vega: f32,
    #[prost(int64, tag = "12")]
    oi: i64,
    #[prost(int64, tag = "13")]
    volume: i64,
    #[prost(int64, tag = "14")]
    ref_id: i64,
    #[prost(int64, tag = "15")]
    prev_oi: i64,
    #[prost(int64, tag = "16")]
    price_pcp: i64,
}

fn default_environment() -> String {
    "PROD".to_string()
}

fn default_instrument() -> String {
    "NIFTY".to_string()
}

fn default_exchange() -> String {
    "NSE".to_string()
}

fn default_stream() -> String {
    "index".to_string()
}

fn default_interval() -> String {
    "5m".to_string()
}

#[derive(Debug, Deserialize)]
struct OiSnapshotQuery {
    token: String,
    #[serde(default = "default_environment")]
    env: String,
    #[serde(default = "default_instrument")]
    instrument: String,
    #[serde(default = "default_exchange")]
    exchange: String,
    expiry: Option<String>,
}

#[derive(Debug, Serialize)]
struct OiLeg {
    ref_id: i64,
    strike: f64,
    oi: i64,
    volume: i64,
}

#[derive(Debug, Serialize)]
struct OiSnapshot {
    instrument: String,
    expiry: String,
    ce: Vec<OiLeg>,
    pe: Vec<OiLeg>,
    atm: f64,
    current_price: f64,
    total_ce_oi: i64,
    total_pe_oi: i64,
    pcr: f64,
    fetched_at_ms: u128,
    from_cache: bool,
}

#[derive(Clone)]
struct AppState {
    http: reqwest::Client,
    redis: Option<Arc<tokio::sync::Mutex<redis::aio::ConnectionManager>>>,
}

#[tokio::main]
async fn main() -> Result<()> {
    let _ = rustls::crypto::ring::default_provider().install_default();

    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env().add_directive("info".parse()?))
        .init();

    let port = std::env::var("RUST_REALTIME_PORT")
        .ok()
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(3003);

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET])
        .allow_headers(Any);

    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()?;

    let redis_url = std::env::var("REDIS_URL")
        .unwrap_or_else(|_| "redis://127.0.0.1:6379".to_string());
    let redis = match redis::Client::open(redis_url.as_str()) {
        Err(e) => { warn!("Redis URL invalid — running without cache: {e}"); None }
        Ok(client) => {
            match tokio::time::timeout(
                std::time::Duration::from_secs(2),
                redis::aio::ConnectionManager::new(client),
            ).await {
                Ok(Ok(mgr)) => {
                    info!("Redis connected at {}", redis_url);
                    Some(Arc::new(tokio::sync::Mutex::new(mgr)))
                }
                Ok(Err(e)) => { warn!("Redis connection failed — running without cache: {e}"); None }
                Err(_)     => { warn!("Redis connection timed out — running without cache"); None }
            }
        }
    };

    let state = AppState { http, redis };

    let app = Router::new()
        .route("/health", get(health))
        .route("/ws/realtime", get(realtime_ws))
        .route("/oi/snapshot", get(oi_snapshot))
        .with_state(state)
        .layer(cors);

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    info!("Rust realtime server running on http://{}", addr);
    axum::serve(listener, app).await?;
    Ok(())
}

async fn health() -> Json<Health> {
    Json(Health {
        status: "ok",
        service: "alphahedge-rust-realtime",
    })
}

async fn realtime_ws(ws: WebSocketUpgrade, Query(query): Query<RealtimeQuery>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| async move {
        if let Err(err) = bridge_nubra(socket, query).await {
            error!("realtime bridge closed: {err:?}");
        }
    })
}

async fn bridge_nubra(mut client: WebSocket, query: RealtimeQuery) -> Result<()> {
    let endpoint = nubra_ws_endpoint(&query.env);
    info!(
        stream = %query.stream,
        instrument = %query.instrument,
        expiry = ?query.expiry,
        "client connected to rust realtime bridge"
    );
    let (upstream, _) = connect_async(endpoint)
        .await
        .with_context(|| format!("connect upstream Nubra websocket at {endpoint}"))?;
    let (mut upstream_tx, mut upstream_rx) = upstream.split();

    let subscribe = subscription_message(&query)?;
    info!(stream = %query.stream, subscribe = %subscribe, "sending Nubra subscription");

    upstream_tx
        .send(tungstenite::Message::Text(subscribe))
        .await
        .context("send Nubra index subscription")?;

    send_json(
        &mut client,
        json!({
            "type": "connected",
            "environment": query.env.to_uppercase(),
            "instrument": query.instrument.to_uppercase(),
            "exchange": query.exchange.to_uppercase(),
            "stream": query.stream.to_lowercase(),
            "received_at_ms": now_ms(),
        }),
    )
    .await?;

    loop {
        tokio::select! {
            upstream_msg = upstream_rx.next() => {
                match upstream_msg {
                    Some(Ok(tungstenite::Message::Text(text))) => {
                        info!(stream = %query.stream, bytes = text.len(), "upstream text message");
                        let payload = serde_json::from_str::<Value>(&text).unwrap_or_else(|_| json!({ "raw": text }));
                        send_json(&mut client, json!({
                            "type": "nubra_text",
                            "received_at_ms": now_ms(),
                            "payload": payload,
                        })).await?;
                    }
                    Some(Ok(tungstenite::Message::Binary(bytes))) => {
                        info!(stream = %query.stream, bytes = bytes.len(), "upstream binary message");
                        let decoded = decode_market_binary(&bytes);
                        send_json(&mut client, decoded.unwrap_or_else(|err| json!({
                            "type": "decode_error",
                            "received_at_ms": now_ms(),
                            "bytes": bytes.len(),
                            "error": err.to_string(),
                        }))).await?;
                    }
                    Some(Ok(tungstenite::Message::Ping(bytes))) => {
                        upstream_tx.send(tungstenite::Message::Pong(bytes)).await?;
                    }
                    Some(Ok(tungstenite::Message::Close(reason))) => {
                        warn!("upstream closed: {:?}", reason);
                        break;
                    }
                    Some(Ok(_)) => {}
                    Some(Err(err)) => return Err(anyhow!("upstream websocket error: {err}")),
                    None => break,
                }
            }
            client_msg = client.recv() => {
                match client_msg {
                    Some(Ok(WsMessage::Text(text))) if text.eq_ignore_ascii_case("ping") => {
                        send_json(&mut client, json!({ "type": "pong", "received_at_ms": now_ms() })).await?;
                    }
                    Some(Ok(WsMessage::Close(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(err)) => return Err(anyhow!("client websocket error: {err}")),
                }
            }
        }

    }

    Ok(())
}

fn subscription_message(query: &RealtimeQuery) -> Result<String> {
    let token = &query.token;
    let exchange = query.exchange.to_uppercase();
    let instrument = query.instrument.to_uppercase();

    // Option chain stream: batch_subscribe {token} option [{"exchange":"NSE","asset":"NIFTY","expiry":"20260602"}]
    if query.stream.eq_ignore_ascii_case("option") {
        let expiry = query
            .expiry
            .as_deref()
            .ok_or_else(|| anyhow!("expiry is required for option stream"))?;
        return Ok(format!(
            "batch_subscribe {token} option [{{\"exchange\":\"{exchange}\",\"asset\":\"{instrument}\",\"expiry\":\"{expiry}\"}}]"
        ));
    }

    // OHLCV candle stream: batch_subscribe {token} index_bucket {"indexes":["NIFTY"]} 5m NSE
    if query.stream.eq_ignore_ascii_case("ohlcv") || query.stream.eq_ignore_ascii_case("index_bucket") {
        let interval = &query.interval;
        return Ok(format!(
            "batch_subscribe {token} index_bucket {{\"indexes\":[\"{instrument}\"]}} {interval} {exchange}"
        ));
    }

    // Default: index LTP stream: batch_subscribe {token} index {"indexes":["NIFTY"]} NSE
    Ok(format!(
        "batch_subscribe {token} index {{\"indexes\":[\"{instrument}\"]}} {exchange}"
    ))
}

async fn send_json(client: &mut WebSocket, value: Value) -> Result<()> {
    client
        .send(WsMessage::Text(value.to_string()))
        .await
        .context("send client websocket message")
}

fn decode_market_binary(bytes: &[u8]) -> Result<Value> {
    let received_at_ms = now_ms();

    let generic = match GenericData::decode(bytes) {
        Ok(generic) => generic,
        Err(_) => {
            if let Ok(batch) = BatchWebSocketIndexMessage::decode(bytes) {
                GenericData {
                    key: "index".to_string(),
                    data: Some(prost_types::Any {
                        type_url: "BatchWebSocketIndexMessage".to_string(),
                        value: batch.encode_to_vec(),
                    }),
                }
            } else if let Ok(bucket) = BatchWebSocketIndexBucketMessage::decode(bytes) {
                GenericData {
                    key: "ohlcv".to_string(),
                    data: Some(prost_types::Any {
                        type_url: "BatchWebSocketIndexBucketMessage".to_string(),
                        value: bucket.encode_to_vec(),
                    }),
                }
            } else {
                let update = WebSocketMsgOptionChainUpdate::decode(bytes)
                    .context("decode direct WebSocketMsgOptionChainUpdate")?;
                GenericData {
                    key: "option".to_string(),
                    data: Some(prost_types::Any {
                        type_url: "WebSocketMsgOptionChainUpdate".to_string(),
                        value: update.encode_to_vec(),
                    }),
                }
            }
        }
    };

    let Some(any) = generic.data else {
        return Ok(json!({
            "type": "generic",
            "key": generic.key,
            "received_at_ms": received_at_ms,
        }));
    };

    if generic.key.eq_ignore_ascii_case("ohlcv")
        || any.type_url.ends_with("BatchWebSocketIndexBucketMessage")
    {
        let bucket = BatchWebSocketIndexBucketMessage::decode(any.value.as_slice())
            .context("decode BatchWebSocketIndexBucketMessage")?;
        return Ok(json!({
            "type": "ohlcv",
            "key": generic.key,
            "type_url": any.type_url,
            "received_at_ms": received_at_ms,
            "payload": bucket,
        }));
    }

    if generic.key.eq_ignore_ascii_case("index")
        || any.type_url.ends_with("BatchWebSocketIndexMessage")
    {
        let batch = BatchWebSocketIndexMessage::decode(any.value.as_slice())
            .context("decode BatchWebSocketIndexMessage")?;
        return Ok(json!({
            "type": "index",
            "key": generic.key,
            "type_url": any.type_url,
            "received_at_ms": received_at_ms,
            "payload": batch,
        }));
    }

    if generic.key.eq_ignore_ascii_case("option")
        || any.type_url.ends_with("WebSocketMsgOptionChainUpdate")
    {
        let update = WebSocketMsgOptionChainUpdate::decode(any.value.as_slice())
            .context("decode WebSocketMsgOptionChainUpdate")?;
        return Ok(json!({
            "type": "option",
            "key": generic.key,
            "type_url": any.type_url,
            "received_at_ms": received_at_ms,
            "payload": update,
        }));
    }

    Ok(json!({
        "type": "unsupported_binary",
        "key": generic.key,
        "type_url": any.type_url,
        "received_at_ms": received_at_ms,
        "bytes": any.value.len(),
    }))
}

async fn oi_snapshot(
    State(state): State<AppState>,
    Query(query): Query<OiSnapshotQuery>,
) -> impl IntoResponse {
    let cache_key = format!(
        "oi:{}:{}:{}",
        query.env.to_uppercase(),
        query.instrument.to_uppercase(),
        query.expiry.as_deref().unwrap_or("nearest"),
    );

    // Try Redis cache first.
    if let Some(ref redis) = state.redis {
        use redis::AsyncCommands;
        let mut conn = redis.lock().await;
        if let Ok(cached) = conn.get::<_, String>(&cache_key).await {
            if let Ok(mut val) = serde_json::from_str::<Value>(&cached) {
                val["from_cache"] = json!(true);
                info!(key = %cache_key, "OI cache hit");
                return Json(val).into_response();
            }
        }
    }

    // Cache miss — fetch from Nubra REST.
    let base = if query.env.eq_ignore_ascii_case("UAT") {
        "https://uatapi.nubra.io"
    } else {
        "https://api.nubra.io"
    };
    let mut url = format!(
        "{}/optionchains/{}?exchange={}",
        base,
        query.instrument.to_uppercase(),
        query.exchange.to_uppercase(),
    );
    if let Some(ref expiry) = query.expiry {
        url.push_str("&expiry=");
        url.push_str(expiry);
    }

    info!(instrument = %query.instrument, expiry = ?query.expiry, "OI REST fetch (cache miss)");

    let res = match state.http
        .get(&url)
        .header("Authorization", format!("Bearer {}", query.token))
        .header("x-device-id", "Nubra-OSS-rust-oi")
        .header("Accept", "application/json")
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            error!("OI snapshot HTTP error: {e}");
            return (StatusCode::BAD_GATEWAY, Json(json!({ "error": e.to_string() }))).into_response();
        }
    };

    let http_status = res.status();
    let body: Value = match res.json().await {
        Ok(v) => v,
        Err(e) => {
            error!("OI snapshot JSON parse error: {e}");
            return (StatusCode::BAD_GATEWAY, Json(json!({ "error": e.to_string() }))).into_response();
        }
    };

    if !http_status.is_success() {
        return (StatusCode::from_u16(http_status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY), Json(body)).into_response();
    }

    let chain = match body.get("chain") {
        Some(c) => c,
        None => return (StatusCode::BAD_GATEWAY, Json(json!({ "error": "no chain in Nubra response" }))).into_response(),
    };

    let parse_legs = |arr: &Value| -> Vec<OiLeg> {
        arr.as_array().map(|a| a.iter().filter_map(|item| {
            Some(OiLeg {
                ref_id: item.get("ref_id")?.as_f64()? as i64,
                strike: item.get("sp")?.as_f64()? / 100.0,
                oi:     item.get("oi")?.as_f64()? as i64,
                volume: item.get("volume")?.as_f64()? as i64,
            })
        }).collect()).unwrap_or_default()
    };

    let ce = parse_legs(chain.get("ce").unwrap_or(&Value::Null));
    let pe = parse_legs(chain.get("pe").unwrap_or(&Value::Null));
    let total_ce_oi: i64 = ce.iter().map(|l| l.oi).sum();
    let total_pe_oi: i64 = pe.iter().map(|l| l.oi).sum();
    let pcr = if total_ce_oi > 0 { total_pe_oi as f64 / total_ce_oi as f64 } else { 0.0 };

    let snap = OiSnapshot {
        instrument:    query.instrument.to_uppercase(),
        expiry:        chain.get("expiry").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        ce,
        pe,
        atm:           chain.get("atm").and_then(|v| v.as_f64()).unwrap_or(0.0) / 100.0,
        current_price: chain.get("cp").and_then(|v| v.as_f64()).unwrap_or(0.0) / 100.0,
        total_ce_oi,
        total_pe_oi,
        pcr,
        fetched_at_ms: now_ms(),
        from_cache:    false,
    };

    // Write to Redis with 3-minute TTL (matching NSE OI update cadence).
    if let Some(ref redis) = state.redis {
        if let Ok(serialized) = serde_json::to_string(&snap) {
            use redis::AsyncCommands;
            let mut conn = redis.lock().await;
            let _: Result<(), _> = conn.set_ex(&cache_key, serialized, 180).await;
            info!(key = %cache_key, "OI written to Redis TTL=180s");
        }
    }

    Json(json!(snap)).into_response()
}

fn nubra_ws_endpoint(env: &str) -> &'static str {
    if env.eq_ignore_ascii_case("UAT") {
        "wss://uatapi.nubra.io/apibatch/ws"
    } else {
        "wss://api.nubra.io/apibatch/ws"
    }
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default()
}
