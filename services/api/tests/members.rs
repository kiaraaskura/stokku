//! Staff invites (T-140): invite, accept, revoke, remove.
//!
//! The properties that matter for a shop:
//! - an invite is single use and expires;
//! - the code is stored only as a hash, so a dump cannot be replayed;
//! - an invite can never create a second owner;
//! - accepting with an email that already has an account requires that
//!   account's password;
//! - removing a member keeps their name on the sales they posted.

mod common;

use axum::extract::{Path, State};
use axum::Json;
use sqlx::{PgPool, Row};
use stokku_api::auth::{login, signup, LoginReq, SignupReq};
use stokku_api::config::AppConfig;
use stokku_api::ctx::{AuthCtx, Role};
use stokku_api::routes::members::{
    accept_invite, create_invite, list_invites, list_members, remove_member, revoke_invite,
    AcceptInviteReq, InviteReq,
};
use stokku_api::state::AppState;
use uuid::Uuid;

fn state(pool: PgPool) -> AppState {
    AppState::new(
        pool,
        AppConfig {
            database_url: String::new(),
            jwt_secret: "test-secret".into(),
            bind_addr: "127.0.0.1:0".into(),
            app_base_url: None,
            build_hash: "test",
        },
    )
}

struct Shop {
    st: AppState,
    owner: AuthCtx,
    email: String,
}

async fn shop(tag: &str) -> Shop {
    let pool = common::fresh_db(tag).await;
    let st = state(pool);
    let email = format!("pemilik-{tag}-{}@test.local", Uuid::now_v7().simple());
    let Json(tok) = signup(
        State(st.clone()),
        Json(SignupReq {
            email: email.clone(),
            password: "SI_SECRET_PASSWORD_1QXW8J4M".into(),
            name: "Pemilik".into(),
            business_name: format!("Warung Undang {tag}"),
        }),
    )
    .await
    .expect("signup");
    let user_id: Uuid = serde_json::from_value(tok["user"]["id"].clone()).unwrap();
    let tenant_id: Uuid = serde_json::from_value(tok["tenant"]["id"].clone()).unwrap();
    Shop {
        st,
        owner: AuthCtx {
            user_id,
            tenant_id,
            role: Role::Owner,
        },
        email,
    }
}

#[tokio::test]
async fn invite_accepts_into_the_shop_as_staff() {
    if common::admin_url().is_none() {
        eprintln!("SKIPPED: STOKKU_TEST_ADMIN_URL not set");
        return;
    }
    let s = shop("invite").await;
    let helper_email = format!("staf-{}@test.local", Uuid::now_v7().simple());

    let Json(inv) = create_invite(
        State(s.st.clone()),
        s.owner.clone(),
        Json(InviteReq {
            email: helper_email.clone(),
        }),
    )
    .await
    .expect("invite");
    let code = inv["code"].as_str().unwrap().to_string();
    assert_eq!(inv["role"], "staff");
    assert_eq!(code.len(), 48, "24 random bytes, hex");

    // stored only as a hash
    let mut tx = s.st.pool.begin().await.unwrap();
    stokku_api::util::set_app_context(&mut tx, Some(s.owner.tenant_id), Some(s.owner.user_id))
        .await
        .unwrap();
    let stored: String = sqlx::query_scalar("select token_hash from membership_invite")
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert_ne!(stored, code, "the clear code must never be stored");

    // open invites are listed, without the code
    let Json(open) = list_invites(State(s.st.clone()), s.owner.clone())
        .await
        .expect("list invites");
    assert_eq!(open["items"].as_array().unwrap().len(), 1);
    assert!(open["items"][0].get("code").is_none());

    // accept: password is set, membership becomes staff
    let Json(acc) = accept_invite(
        State(s.st.clone()),
        Json(AcceptInviteReq {
            code: code.clone(),
            password: "SI_SECRET_PASSWORD_3LMN5PQ2".into(),
            name: None,
        }),
    )
    .await
    .expect("accept");
    assert_eq!(acc["accepted"], true);
    assert_eq!(acc["role"], "staff");
    assert_eq!(acc["tenant_id"], s.owner.tenant_id.to_string());

    // the new account can log in and is staff
    let Json(session) = login(
        State(s.st.clone()),
        Json(LoginReq {
            email: helper_email.clone(),
            password: "SI_SECRET_PASSWORD_3LMN5PQ2".into(),
        }),
    )
    .await
    .expect("login");
    assert_eq!(session["role"], "staff");

    // the same code cannot be used twice
    let again = accept_invite(
        State(s.st.clone()),
        Json(AcceptInviteReq {
            code,
            password: "SI_SECRET_PASSWORD_3LMN5PQ2".into(),
            name: None,
        }),
    )
    .await;
    assert!(again.is_err(), "an invite is single use");

    let Json(members) = list_members(State(s.st.clone()), s.owner.clone())
        .await
        .expect("members");
    assert_eq!(members["items"].as_array().unwrap().len(), 2);

    common::drop_db(s.st.pool.clone()).await;
}

#[tokio::test]
async fn invite_cannot_be_used_without_the_right_password() {
    if common::admin_url().is_none() {
        eprintln!("SKIPPED: STOKKU_TEST_ADMIN_URL not set");
        return;
    }
    let s = shop("inviteowner").await;

    // the owner invites their own second address: harmless in real life
    let second = format!("kedua-{}@test.local", Uuid::now_v7().simple());
    let Json(inv) = create_invite(
        State(s.st.clone()),
        s.owner.clone(),
        Json(InviteReq { email: second }),
    )
    .await
    .expect("invite");
    let code = inv["code"].as_str().unwrap().to_string();
    let Json(_acc) = accept_invite(
        State(s.st.clone()),
        Json(AcceptInviteReq {
            code: code.clone(),
            password: "SI_SECRET_PASSWORD_8WXZ2KR4".into(),
            name: None,
        }),
    )
    .await
    .expect("accept first time");

    // an invite for an email that is already a member is refused up front
    let existing_member = create_invite(
        State(s.st.clone()),
        s.owner.clone(),
        Json(InviteReq {
            email: s.email.clone(),
        }),
    )
    .await;
    assert!(
        existing_member.is_err(),
        "inviting an existing member is pointless"
    );

    // direct check of the password rule on an existing, non-member account
    let outsider = format!("luar-{}@test.local", Uuid::now_v7().simple());
    let Json(tok) = signup(
        State(s.st.clone()),
        Json(SignupReq {
            email: outsider.clone(),
            password: "SI_SECRET_PASSWORD_6TYU1IO9".into(),
            name: "Luar".into(),
            business_name: "Warung Lain".into(),
        }),
    )
    .await
    .expect("outsider signup");
    let outsider_user: Uuid = serde_json::from_value(tok["user"]["id"].clone()).unwrap();
    assert_ne!(outsider_user, s.owner.user_id);

    let Json(inv3) = create_invite(
        State(s.st.clone()),
        s.owner.clone(),
        Json(InviteReq {
            email: outsider.clone(),
        }),
    )
    .await
    .expect("invite outsider");
    let code3 = inv3["code"].as_str().unwrap().to_string();

    let wrong = accept_invite(
        State(s.st.clone()),
        Json(AcceptInviteReq {
            code: code3,
            password: "SI_SECRET_PASSWORD_0PLK3JH7".into(),
            name: None,
        }),
    )
    .await;
    assert!(
        wrong.is_err(),
        "an existing account must prove itself with its own password"
    );

    common::drop_db(s.st.pool.clone()).await;
}

#[tokio::test]
async fn only_the_owner_manages_members() {
    if common::admin_url().is_none() {
        eprintln!("SKIPPED: STOKKU_TEST_ADMIN_URL not set");
        return;
    }
    let s = shop("inviterole").await;
    let staff = AuthCtx {
        user_id: Uuid::now_v7(),
        tenant_id: s.owner.tenant_id,
        role: Role::Staff,
    };
    let refused = create_invite(
        State(s.st.clone()),
        staff.clone(),
        Json(InviteReq {
            email: "x@test.local".into(),
        }),
    )
    .await;
    assert!(refused.is_err(), "staff cannot invite");

    let Json(inv) = create_invite(
        State(s.st.clone()),
        s.owner.clone(),
        Json(InviteReq {
            email: "y@test.local".into(),
        }),
    )
    .await
    .expect("invite");
    let id: Uuid = serde_json::from_value(inv["id"].clone()).unwrap();

    // revoke, and the code stops working
    let Json(rev) = revoke_invite(State(s.st.clone()), s.owner.clone(), Path(id))
        .await
        .expect("revoke");
    assert_eq!(rev["revoked"], true);
    let dead = accept_invite(
        State(s.st.clone()),
        Json(AcceptInviteReq {
            code: inv["code"].as_str().unwrap().to_string(),
            password: "SI_SECRET_PASSWORD_9QAZ4WSX".into(),
            name: None,
        }),
    )
    .await;
    assert!(dead.is_err(), "a revoked code must not work");

    common::drop_db(s.st.pool.clone()).await;
}

#[tokio::test]
async fn owner_keeps_the_shop_and_history_keeps_the_name() {
    if common::admin_url().is_none() {
        eprintln!("SKIPPED: STOKKU_TEST_ADMIN_URL not set");
        return;
    }
    let s = shop("inviteremove").await;

    // cannot remove yourself
    let self_remove =
        remove_member(State(s.st.clone()), s.owner.clone(), Path(s.owner.user_id)).await;
    assert!(self_remove.is_err(), "an owner cannot remove themselves");

    // add a helper, then remove them
    let helper = format!("bantu-{}@test.local", Uuid::now_v7().simple());
    let Json(inv) = create_invite(
        State(s.st.clone()),
        s.owner.clone(),
        Json(InviteReq {
            email: helper.clone(),
        }),
    )
    .await
    .expect("invite");
    let Json(_acc2) = accept_invite(
        State(s.st.clone()),
        Json(AcceptInviteReq {
            code: inv["code"].as_str().unwrap().to_string(),
            password: "SI_SECRET_PASSWORD_2WSX6EDC".into(),
            name: Some("Budi".into()),
        }),
    )
    .await
    .expect("accept");

    let mut tx = s.st.pool.begin().await.unwrap();
    stokku_api::util::set_app_context(&mut tx, Some(s.owner.tenant_id), Some(s.owner.user_id))
        .await
        .unwrap();
    let (helper_id, helper_name): (Uuid, String) = {
        let row = sqlx::query(
            "select user_id, name from auth_members_of_tenant($1) where role = 'staff'",
        )
        .bind(s.owner.tenant_id)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        (row.get("user_id"), row.get("name"))
    };
    tx.commit().await.unwrap();
    assert_eq!(helper_name, "Budi");

    let Json(rem) = remove_member(State(s.st.clone()), s.owner.clone(), Path(helper_id))
        .await
        .expect("remove helper");
    assert_eq!(rem["removed"], true);

    // membership gone, user row kept so their name survives on history
    let mut tx = s.st.pool.begin().await.unwrap();
    stokku_api::util::set_app_context(&mut tx, Some(s.owner.tenant_id), Some(s.owner.user_id))
        .await
        .unwrap();
    let memberships: i64 = sqlx::query_scalar("select count(*) from membership")
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(memberships, 1, "only the owner remains");

    let user_still: Option<String> = sqlx::query_scalar("select name from auth_find_user($1)")
        .bind(&helper)
        .fetch_optional(&s.st.pool)
        .await
        .unwrap();
    assert_eq!(user_still.as_deref(), Some("Budi"));

    common::drop_db(s.st.pool.clone()).await;
}
