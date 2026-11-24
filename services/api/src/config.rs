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
        let bind_addr = std::env::var("BIND_ADDR").unwrap_or_else(|_| {
            match std::env::var("PORT") {
                Ok(p) => format!("0.0.0.0:{p}"),
                Err(_) => "0.0.0.0:8080".to_string(),
            }
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
