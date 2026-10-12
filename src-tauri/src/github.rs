//! GitHub, over GraphQL.
//!
//! Two queries, because they change at completely different rates. Pull
//! requests and CI can flip while you watch them; your contribution graph
//! cannot. Asking for both on one timer would either hammer the API or leave
//! the pull requests stale, so they are fetched separately.
//!
//! Search rather than the viewer's own connections: `review-requested:@me` is
//! the only way to get PRs waiting on you, and it returns the same shape for
//! both lists.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;

const ENDPOINT: &str = "https://api.github.com/graphql";

/// How long a fetched answer is reused. Clicking the panel does not re-ask
/// inside this window; the Refresh button does.
const PULSE_TTL: Duration = Duration::from_secs(60);
const ACTIVITY_TTL: Duration = Duration::from_secs(300);

/// How many weeks of contributions the sparkline shows.
const WEEKS: usize = 23;

const PULSE_QUERY: &str = r#"
query RyfePulse {
  viewer { login }
  authored: search(query: "is:pr is:open author:@me sort:updated-desc", type: ISSUE, first: 25) {
    nodes {
      ... on PullRequest {
        number title url isDraft reviewDecision
        repository { nameWithOwner }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
  reviewing: search(query: "is:pr is:open review-requested:@me sort:updated-desc", type: ISSUE, first: 25) {
    nodes {
      ... on PullRequest {
        number title url isDraft reviewDecision
        repository { nameWithOwner }
        author { login }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}
"#;

const ACTIVITY_QUERY: &str = r#"
query RyfeActivity {
  viewer {
    login
    contributionsCollection {
      contributionCalendar {
        totalContributions
        weeks { contributionDays { date contributionCount } }
      }
    }
    repositories(first: 10, orderBy: { field: PUSHED_AT, direction: DESC }, ownerAffiliations: OWNER) {
      nodes {
        nameWithOwner
        defaultBranchRef {
          name
          target { ... on Commit { statusCheckRollup { state } } }
        }
      }
    }
  }
}
"#;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone, Debug, Default)]
pub struct PullRequest {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub repo: String,
    pub author: String,
    pub draft: bool,
    /// success | failure | pending | error | expected | none
    pub ci: String,
    /// APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | ""
    pub review: String,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct Pulse {
    pub login: String,
    pub authored: Vec<PullRequest>,
    pub reviewing: Vec<PullRequest>,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct RepoCi {
    pub repo: String,
    pub branch: String,
    pub ci: String,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct Activity {
    pub login: String,
    pub total: u32,
    /// One count per day, oldest first, for the sparkline.
    pub days: Vec<u32>,
    /// The first day covered, as `yyyy-mm-dd`, so the sparkline can be labelled.
    pub from: String,
    pub repos: Vec<RepoCi>,
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

async fn graphql(token: &str, query: &str) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    let res = client
        .post(ENDPOINT)
        .header("Authorization", format!("Bearer {token}"))
        // GitHub rejects requests with no User-Agent.
        .header("User-Agent", "ryfe")
        .header("Accept", "application/vnd.github+json")
        .json(&serde_json::json!({ "query": query }))
        .send()
        .await
        .map_err(|e| format!("could not reach GitHub: {e}"))?;

    let status = res.status();
    let body = res
        .text()
        .await
        .map_err(|e| format!("could not read GitHub's reply: {e}"))?;

    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err("GitHub rejected the token. Check it has not expired.".to_string());
    }
    if !status.is_success() {
        return Err(format!("GitHub returned {status}"));
    }

    let json: Value =
        serde_json::from_str(&body).map_err(|e| format!("GitHub sent something odd: {e}"))?;

    // GraphQL answers 200 with an `errors` array, so a failure has to be read
    // out of the body rather than the status code.
    if let Some(errors) = json.get("errors").and_then(|e| e.as_array()) {
        if let Some(first) = errors.first() {
            let msg = first
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("unknown error");
            return Err(format!("GitHub: {msg}"));
        }
    }

    Ok(json)
}

fn s(v: &Value, path: &[&str]) -> String {
    let mut cur = v;
    for p in path {
        match cur.get(*p) {
            Some(next) => cur = next,
            None => return String::new(),
        }
    }
    cur.as_str().unwrap_or_default().to_string()
}

/// `statusCheckRollup` is null when a commit has no checks at all, which is
/// different from "passing" and worth showing differently.
fn ci_state(commit: &Value) -> String {
    let rollup = commit
        .get("statusCheckRollup")
        .filter(|v| !v.is_null());
    match rollup {
        None => "none".to_string(),
        Some(r) => r
            .get("state")
            .and_then(|v| v.as_str())
            .unwrap_or("none")
            .to_lowercase(),
    }
}

fn parse_pr(node: &Value) -> PullRequest {
    let commit = node
        .get("commits")
        .and_then(|c| c.get("nodes"))
        .and_then(|n| n.as_array())
        .and_then(|a| a.first())
        .and_then(|n| n.get("commit"));

    PullRequest {
        number: node.get("number").and_then(|v| v.as_u64()).unwrap_or(0),
        title: s(node, &["title"]),
        url: s(node, &["url"]),
        repo: s(node, &["repository", "nameWithOwner"]),
        author: s(node, &["author", "login"]),
        draft: node.get("isDraft").and_then(|v| v.as_bool()).unwrap_or(false),
        ci: commit.map(ci_state).unwrap_or_else(|| "none".to_string()),
        review: s(node, &["reviewDecision"]),
    }
}

fn parse_prs(value: &Value, key: &str) -> Vec<PullRequest> {
    value
        .get("data")
        .and_then(|d| d.get(key))
        .and_then(|a| a.get("nodes"))
        .and_then(|n| n.as_array())
        .map(|nodes| nodes.iter().filter(|n| !n.is_null()).map(parse_pr).collect())
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

struct Cache<T> {
    value: Option<T>,
    at: Option<Instant>,
}

impl<T> Default for Cache<T> {
    fn default() -> Self {
        Cache { value: None, at: None }
    }
}

impl<T: Clone> Cache<T> {
    fn fresh(&self, ttl: Duration) -> Option<T> {
        match (&self.value, self.at) {
            (Some(v), Some(t)) if t.elapsed() < ttl => Some(v.clone()),
            _ => None,
        }
    }
    fn store(&mut self, v: T) {
        self.value = Some(v);
        self.at = Some(Instant::now());
    }
    fn clear(&mut self) {
        self.value = None;
        self.at = None;
    }
}

static PULSE: Mutex<Cache<Pulse>> = Mutex::new(Cache { value: None, at: None });
static ACTIVITY: Mutex<Cache<Activity>> = Mutex::new(Cache { value: None, at: None });

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

fn token() -> Result<String, String> {
    crate::secrets::get("github-token")
        .ok_or_else(|| "No GitHub token yet. Add one in Settings → GitHub.".to_string())
}

/// Pull requests you wrote, and pull requests waiting on your review.
#[tauri::command]
pub async fn gh_pulse(force: bool) -> Result<Pulse, String> {
    if !force {
        if let Ok(cache) = PULSE.lock() {
            if let Some(v) = cache.fresh(PULSE_TTL) {
                return Ok(v);
            }
        }
    }

    let token = token()?;
    let value = graphql(&token, PULSE_QUERY).await?;

    let pulse = Pulse {
        login: s(&value, &["data", "viewer", "login"]),
        authored: parse_prs(&value, "authored"),
        reviewing: parse_prs(&value, "reviewing"),
    };

    if let Ok(mut cache) = PULSE.lock() {
        cache.store(pulse.clone());
    }
    Ok(pulse)
}

/// The contribution graph, and the CI state of your most recently pushed repos.
#[tauri::command]
pub async fn gh_activity(force: bool) -> Result<Activity, String> {
    if !force {
        if let Ok(cache) = ACTIVITY.lock() {
            if let Some(v) = cache.fresh(ACTIVITY_TTL) {
                return Ok(v);
            }
        }
    }

    let token = token()?;
    let value = graphql(&token, ACTIVITY_QUERY).await?;

    // The calendar comes back as weeks of days; flatten it, keeping the last
    // WEEKS weeks so the sparkline is a fixed width.
    let mut days = Vec::new();
    let mut from = String::new();
    if let Some(weeks) = value
        .get("data")
        .and_then(|d| d.get("viewer"))
        .and_then(|v| v.get("contributionsCollection"))
        .and_then(|c| c.get("contributionCalendar"))
        .and_then(|c| c.get("weeks"))
        .and_then(|w| w.as_array())
    {
        let start = weeks.len().saturating_sub(WEEKS);
        for week in &weeks[start..] {
            if let Some(ds) = week.get("contributionDays").and_then(|d| d.as_array()) {
                for day in ds {
                    if from.is_empty() {
                        from = s(day, &["date"]);
                    }
                    days.push(
                        day.get("contributionCount")
                            .and_then(|c| c.as_u64())
                            .unwrap_or(0) as u32,
                    );
                }
            }
        }
    }

    let repos = value
        .get("data")
        .and_then(|d| d.get("viewer"))
        .and_then(|v| v.get("repositories"))
        .and_then(|r| r.get("nodes"))
        .and_then(|n| n.as_array())
        .map(|nodes| {
            nodes
                .iter()
                .filter(|n| !n.is_null())
                .map(|n| {
                    let branch_ref = n.get("defaultBranchRef");
                    RepoCi {
                        repo: s(n, &["nameWithOwner"]),
                        branch: branch_ref
                            .map(|b| s(b, &["name"]))
                            .unwrap_or_default(),
                        ci: branch_ref
                            .and_then(|b| b.get("target"))
                            .filter(|t| !t.is_null())
                            .map(ci_state)
                            .unwrap_or_else(|| "none".to_string()),
                    }
                })
                .collect()
        })
        .unwrap_or_default();

    let activity = Activity {
        login: s(&value, &["data", "viewer", "login"]),
        total: value
            .get("data")
            .and_then(|d| d.get("viewer"))
            .and_then(|v| v.get("contributionsCollection"))
            .and_then(|c| c.get("contributionCalendar"))
            .and_then(|c| c.get("totalContributions"))
            .and_then(|t| t.as_u64())
            .unwrap_or(0) as u32,
        days,
        from,
        repos,
    };

    if let Ok(mut cache) = ACTIVITY.lock() {
        cache.store(activity.clone());
    }
    Ok(activity)
}

/// Creates a repository on the signed-in account, or finds the one already
/// there, and returns its https clone URL.
///
/// Private unless the caller says otherwise: whoever fetched a public repository
/// keeps their copy, so it cannot be taken back.
///
/// Finding matters as much as creating. A connect that failed *after* the
/// repository was made — a push with no stored credential, say — must not
/// strand the folder with a name it can no longer use.
#[tauri::command]
pub async fn gh_create_repo(name: String, private: bool) -> Result<String, String> {
    // Checked before it goes near the query, which is also what makes putting
    // it inside a string safe.
    if !valid_repo_name(&name) {
        return Err(
            "A repository name can only use letters, numbers, dot, dash and underscore."
                .to_string(),
        );
    }

    let token = token()?;
    let visibility = if private { "PRIVATE" } else { "PUBLIC" };
    let create = format!(
        "mutation {{ createRepository(input: {{name: \"{name}\", visibility: {visibility}}}) {{ repository {{ url }} }} }}"
    );

    let made = match graphql(&token, &create).await {
        Ok(value) => s(&value, &["data", "createRepository", "repository", "url"]),
        Err(reason) => {
            // Either it already exists, or it is not this account's to make.
            // Ask which, and keep the creation error when the answer is neither.
            let look = format!("query {{ viewer {{ repository(name: \"{name}\") {{ url }} }} }}");
            let value = graphql(&token, &look).await?;
            let found = s(&value, &["data", "viewer", "repository", "url"]);
            if found.is_empty() {
                return Err(reason);
            }
            found
        }
    };

    if made.is_empty() {
        return Err("GitHub did not return the repository's address".to_string());
    }
    // The GraphQL API has no clone URL field; the https one is the web URL + .git.
    Ok(format!("{made}.git"))
}

fn valid_repo_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 100
        && name != "."
        && name != ".."
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

#[cfg(test)]
mod tests {
    use super::valid_repo_name;

    #[test]
    fn repo_names_that_could_break_out_of_the_query_are_refused() {
        assert!(valid_repo_name("ryfe"));
        assert!(valid_repo_name("my.repo-2_x"));
        assert!(!valid_repo_name(""));
        assert!(!valid_repo_name(".."));
        assert!(!valid_repo_name("has space"));
        assert!(!valid_repo_name("quote\"or-brace}"));
        assert!(!valid_repo_name(&"a".repeat(101)));
    }
}

/// Forgets everything. Called when the token changes, so a new account never
/// sees the previous one's pull requests.
#[tauri::command]
pub fn gh_forget() {
    if let Ok(mut c) = PULSE.lock() {
        c.clear();
    }
    if let Ok(mut c) = ACTIVITY.lock() {
        c.clear();
    }
}
