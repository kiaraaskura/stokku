use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use jsonwebtoken::{decode, DecodingKey, Validation};
use serde::Deserialize;
use uuid::Uuid;

use crate::error::ApiError;
use crate::state::AppState;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Owner,
    Staff,
}

impl Role {
    pub fn as_str(&self) -> &'static str {
        match self {
            Role::Owner => "owner",
            Role::Staff => "staff",
        }
    }

    pub fn parse(s: &str) -> Option<Role> {
        match s {
            "owner" => Some(Role::Owner),
            "staff" => Some(Role::Staff),
            _ => None,
        }
    }

    /// Capability matrix from docs/API_CONTRACT.md "Access".
    /// Staff never receives cost.read, report.read, item.write,
    /// member.manage, export.
    pub fn capabilities(&self) -> Vec<&'static str> {
        match self {
            Role::Owner => vec![
                "stock.write",
                "sales.write",
                "cash.write",
                "report.read",
                "cost.read",
                "item.write",
                "member.manage",
                "export",
            ],
            Role::Staff => vec!["stock.write", "sales.write", "cash.write"],
        }
    }
}

#[derive(Debug, Clone)]
pub struct AuthCtx {
    pub user_id: Uuid,
    pub tenant_id: Uuid,
    pub role: Role,
}

#[derive(Debug, Clone, Copy)]
pub enum Cap {
    StockWrite,
    SalesWrite,
    CashWrite,
    ReportRead,
    CostRead,
    ItemWrite,
    MemberManage,
    Export,
}

impl Cap {
    fn allowed(&self, role: Role) -> bool {
        matches!(
            (self, role),
            (Cap::StockWrite, _)
                | (Cap::SalesWrite, _)
                | (Cap::CashWrite, _)
                | (Cap::ReportRead, Role::Owner)
                | (Cap::CostRead, Role::Owner)
                | (Cap::ItemWrite, Role::Owner)
                | (Cap::MemberManage, Role::Owner)
                | (Cap::Export, Role::Owner)
        )
    }
}

impl AuthCtx {
    /// T-141: capability enforcement inside handlers, not just the UI.
    pub fn require(&self, cap: Cap) -> Result<(), ApiError> {
        if cap.allowed(self.role) {
            Ok(())
        } else {
            Err(ApiError::Forbidden(
                "Peran Anda tidak punya akses ke aksi ini".into(),
            ))
        }
    }

    pub fn can_read_cost(&self) -> bool {
        Cap::CostRead.allowed(self.role)
    }
}

#[derive(Debug, Deserialize)]
pub struct AccessClaims {
    pub sub: String,
    pub tenant: String,
    pub role: String,
    pub exp: i64,
}

impl FromRequestParts<AppState> for AuthCtx {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let header = parts
            .headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .ok_or_else(|| ApiError::Unauthorized("Token akses wajib dikirim".into()))?;

        let claims = decode::<AccessClaims>(
            header,
            &DecodingKey::from_secret(state.cfg.jwt_secret.as_bytes()),
            &Validation::new(jsonwebtoken::Algorithm::HS256),
        )
        .map_err(|_| ApiError::Unauthorized("Token akses tidak valid atau kedaluwarsa".into()))?;

        let user_id = Uuid::parse_str(&claims.claims.sub)
            .map_err(|_| ApiError::Unauthorized("Token akses tidak valid".into()))?;
        let tenant_id = Uuid::parse_str(&claims.claims.tenant)
            .map_err(|_| ApiError::Unauthorized("Token akses tidak valid".into()))?;
        let role = Role::parse(&claims.claims.role)
            .ok_or_else(|| ApiError::Unauthorized("Token akses tidak valid".into()))?;

        Ok(AuthCtx {
            user_id,
            tenant_id,
            role,
        })
    }
}
