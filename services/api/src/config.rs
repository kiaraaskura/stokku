/// Config from env (docs/DECISIONS.md technical defaults).
#[derive(Clone, Debug)]
pub struct AppConfig {
    pub database_url: String,
    pub jwt_secret: String,
    pub bind_addr: String,
    pub app_base_url: Option<String>,
    pub build_hash: &'static str,
}

impl AppConfig {
    pub fn from_env() -> Self {
        let database_url = std::env::var("DATABASE_URL")
            .unwrap_or_else(|_| panic!("DATABASE_URL wajib diisi (lihat .env.example)"));
        let jwt_secret = std::env::var("JWT_SECRET")
            .unwrap_or_else(|_| panic!("JWT_SECRET wajib diisi (lihat .env.example)"));
        let bind_addr =
            std::env::var("BIND_ADDR").unwrap_or_else(|_| match std::env::var("PORT") {
                // Loopback by default: a shop PC must not answer the whole
                // Wi-Fi just because the API started. A phone reaches it only
                // after the owner opts in with BIND_ADDR=0.0.0.0:<port>.
                Ok(p) => format!("127.0.0.1:{p}"),
                Err(_) => "127.0.0.1:8080".to_string(),
            });
        Self {
            database_url,
            jwt_secret,
            bind_addr,
            app_base_url: std::env::var("APP_BASE_URL").ok(),
            build_hash: option_env!("BUILD_HASH").unwrap_or("dev"),
        }
    }
}

/// Browser origins the API will answer. Replaces the old permissive CORS:
/// a shop PC that can be reached from the Wi-Fi (or a café network) must not
/// let any random website call the API with a stored token.
///
/// `APP_BASE_URL` is the web origin; `CORS_ORIGINS` adds extras (comma
/// separated) for LAN use, e.g. `http://192.168.1.5:8080`. The local dev and
/// static-serve origins stay allowed so `make dev` and the prebuilt web build
/// keep working without configuration.
pub fn cors_origins(app_base_url: Option<&str>, extra: Option<&str>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut push = |o: &str| {
        let o = o.trim().trim_end_matches('/');
        if !o.is_empty() && !out.iter().any(|x| x == o) {
            out.push(o.to_string());
        }
    };
    for dev in [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:8080",
        "http://127.0.0.1:8080",
    ] {
        push(dev);
    }
    if let Some(base) = app_base_url {
        push(base);
    }
    if let Some(extra) = extra {
        for o in extra.split(',') {
            push(o);
        }
    }
    out
}

pub fn cors_origins_from_env() -> Vec<String> {
    cors_origins(
        std::env::var("APP_BASE_URL").ok().as_deref(),
        std::env::var("CORS_ORIGINS").ok().as_deref(),
    )
}

#[cfg(test)]
mod tests {
    use super::cors_origins;

    #[test]
    fn dev_origins_are_allowed_and_never_a_wildcard() {
        let out = cors_origins(None, None);
        assert!(out.contains(&"http://localhost:5173".to_string()));
        assert!(out.contains(&"http://127.0.0.1:8080".to_string()));
        assert!(!out.iter().any(|o| o == "*"), "never wildcard");
    }

    #[test]
    fn app_base_url_is_added_once_without_trailing_slash() {
        let out = cors_origins(Some("http://192.168.1.5:8080/"), None);
        assert_eq!(
            out.iter()
                .filter(|o| *o == "http://192.168.1.5:8080")
                .count(),
            1
        );
        assert!(!out.iter().any(|o| o.ends_with('/')));
    }

    #[test]
    fn extra_lan_origins_are_split_and_deduped() {
        let out = cors_origins(
            Some("http://192.168.1.5:8080"),
            Some("http://192.168.1.5:8080, http://10.0.0.7:8080 ,"),
        );
        assert_eq!(
            out.iter()
                .filter(|o| *o == "http://192.168.1.5:8080")
                .count(),
            1
        );
        assert!(out.contains(&"http://10.0.0.7:8080".to_string()));
    }
}
