use anyhow::{anyhow, Result};
use reqwest::{Client, StatusCode};
use serde::Deserialize;
use serde_json::json;
use std::{env, fs, path::Path};
use uuid::Uuid;

pub const FREE_CLOUD_LIMIT_TOKENS: u64 = 100_000;
pub const CLOUD_QUOTA_RESERVATION_TTL_SECONDS: u64 = 7_200;
const QUOTA_HEADER: &str = "X-BotConnector-Quota-Internal-Token";
const USER_HEADER: &str = "X-BotConnector-User-ID";
const REQUEST_HEADER: &str = "X-BotConnector-Request-ID";

#[derive(Clone, Debug)]
pub struct CloudQuotaClient {
    client: Client,
    base: String,
    token: String,
}

#[derive(Clone, Copy, Debug)]
pub struct CloudQuotaContext {
    pub user_id: Uuid,
    pub request_id: Uuid,
}

#[derive(Clone, Debug, Deserialize)]
pub struct CloudQuotaReservation {
    pub status: String,
    pub reserved_tokens: u64,
}

#[derive(Clone, Debug, Deserialize)]
pub struct CloudQuotaStatus {
    pub limit_tokens_24h: u64,
    pub used_tokens_24h: u64,
    pub remaining_tokens_24h: u64,
}

#[derive(Debug)]
pub enum CloudQuotaError {
    Exhausted,
    Unavailable,
    Rejected(String),
}

impl std::fmt::Display for CloudQuotaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Exhausted => write!(f, "Cloud token allowance exhausted."),
            Self::Unavailable => write!(f, "Cloud quota service is unavailable."),
            Self::Rejected(_) => write!(f, "Cloud quota request was rejected."),
        }
    }
}

impl std::error::Error for CloudQuotaError {}

impl CloudQuotaClient {
    pub fn from_env() -> Result<Self> {
        let base = env::var("BOTCONNECTOR_ACCOUNT_API_BASE")
            .map_err(|_| anyhow!("Cloud quota service is unavailable."))?;
        let token_path = env::var("BOTCONNECTOR_QUOTA_INTERNAL_TOKEN_FILE")
            .map_err(|_| anyhow!("Cloud quota service is unavailable."))?;
        let token = fs::read_to_string(Path::new(&token_path))
            .map_err(|_| anyhow!("Cloud quota service is unavailable."))?
            .trim()
            .to_owned();
        if base.trim().is_empty() || token.is_empty() {
            return Err(anyhow!("Cloud quota service is unavailable."));
        }
        let client = Client::builder()
            .no_proxy()
            .timeout(std::time::Duration::from_secs(8))
            .build()?;
        Ok(Self {
            client,
            base: base.trim_end_matches('/').to_owned(),
            token,
        })
    }

    fn request(&self, context: CloudQuotaContext, path: &str) -> reqwest::RequestBuilder {
        self.client
            .post(format!("{}{}", self.base, path))
            .header(QUOTA_HEADER, &self.token)
            .header(USER_HEADER, context.user_id.to_string())
            .header(REQUEST_HEADER, context.request_id.to_string())
    }

    pub async fn reserve(
        &self,
        context: CloudQuotaContext,
        requested_tokens: u64,
    ) -> Result<CloudQuotaReservation> {
        let response = self
            .request(context, "/v1/cloud-quota/reserve")
            .json(&json!({ "requested_tokens": requested_tokens }))
            .send()
            .await
            .map_err(|_| CloudQuotaError::Unavailable)?;
        match response.status() {
            StatusCode::OK => response
                .json()
                .await
                .map_err(|_| CloudQuotaError::Unavailable.into()),
            StatusCode::TOO_MANY_REQUESTS => Err(CloudQuotaError::Exhausted.into()),
            _ => Err(CloudQuotaError::Rejected(response.status().to_string()).into()),
        }
    }

    pub async fn settle(
        &self,
        context: CloudQuotaContext,
        input_tokens: u64,
        output_tokens: u64,
        provider: &str,
        model: &str,
    ) -> Result<CloudQuotaStatus> {
        let response = self.request(context, "/v1/cloud-quota/settle")
            .json(&json!({ "input_tokens": input_tokens, "output_tokens": output_tokens, "provider": provider, "model": model, "cost": null }))
            .send().await.map_err(|_| CloudQuotaError::Unavailable)?;
        if response.status() != StatusCode::OK {
            return Err(CloudQuotaError::Rejected(response.status().to_string()).into());
        }
        response
            .json()
            .await
            .map_err(|_| CloudQuotaError::Unavailable.into())
    }

    pub async fn settle_with_retry(
        &self,
        context: CloudQuotaContext,
        input_tokens: u64,
        output_tokens: u64,
        provider: &str,
        model: &str,
    ) -> Result<CloudQuotaStatus> {
        let mut last = None;
        for attempt in 0..=2 {
            match self
                .settle(context, input_tokens, output_tokens, provider, model)
                .await
            {
                Ok(status) => return Ok(status),
                Err(error) => last = Some(error),
            }
            if attempt < 2 {
                tokio::time::sleep(std::time::Duration::from_millis(50 * (attempt + 1))).await;
            }
        }
        Err(last.unwrap_or_else(|| anyhow!("Cloud quota service is unavailable.")))
    }

    pub async fn release(&self, context: CloudQuotaContext) -> Result<()> {
        let response = self
            .request(context, "/v1/cloud-quota/release")
            .json(&json!({}))
            .send()
            .await
            .map_err(|_| CloudQuotaError::Unavailable)?;
        if response.status() != StatusCode::OK {
            return Err(CloudQuotaError::Rejected(response.status().to_string()).into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quota_contract_constants_are_locked() {
        assert_eq!(FREE_CLOUD_LIMIT_TOKENS, 100_000);
        assert_eq!(CLOUD_QUOTA_RESERVATION_TTL_SECONDS, 7_200);
    }

    #[test]
    fn quota_errors_are_sanitized() {
        let error = CloudQuotaError::Rejected("secret-status".to_string());
        assert_eq!(error.to_string(), "Cloud quota request was rejected.");
        assert!(!error.to_string().contains("secret-status"));
    }
}
