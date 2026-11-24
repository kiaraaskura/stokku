use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::{Duration, Instant};

use sqlx::PgPool;
use tokio::sync::Mutex;

use crate::config::AppConfig;

#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    pub cfg: Arc<AppConfig>,
    pub login_limiter: LoginLimiter,
}

impl AppState {
    pub fn new(pool: PgPool, cfg: AppConfig) -> Self {
        Self {
            pool,
            cfg: Arc::new(cfg),
            login_limiter: LoginLimiter::default(),
        }
    }
}

/// Small in-memory login rate limiter: max `max` attempts per key
/// (email) per `window`. Good enough for the MVP spine; a shared
/// limiter belongs to a later increment.
#[derive(Clone, Default)]
pub struct LoginLimiter {
    inner: Arc<Mutex<HashMap<String, VecDeque<Instant>>>>,
}

impl LoginLimiter {
    const WINDOW: Duration = Duration::from_secs(60);
    const MAX: usize = 10;

    pub async fn allow(&self, key: &str) -> bool {
        let now = Instant::now();
        let mut map = self.inner.lock().await;
        let q = map.entry(key.to_string()).or_default();
        while let Some(front) = q.front() {
            if now.duration_since(*front) > Self::WINDOW {
                q.pop_front();
            } else {
                break;
            }
        }
        if q.len() >= Self::MAX {
            return false;
        }
        q.push_back(now);
        true
    }
}
