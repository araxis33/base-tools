// The clock for jobs that live in GitHub Actions (2.11.2026).
//
// GitHub's own `schedule` trigger is best-effort: "every 30 minutes" for Stock
// Check's quotes ran every 3-7 hours, and Night Shift's Monday 13:25 run did not
// come at all, so the page showed Base prices seven hours old. Cloudflare's cron
// fires on time, and a workflow_dispatch is started at once, so this Worker asks
// GitHub to run each job when it is due. Times are New York times where the job
// is about the US market, so summer and winter time take care of themselves.
//
// Secret: GH_DISPATCH_TOKEN, the same one boards.js uses for the stocks board: a
// fine-grained GitHub token with "Actions: read and write" on araxis33/base-tools
// and araxis33/night-shift only (both repos since 2.11.2026). Without it, nothing runs.

const GH = 'https://api.github.com/repos/araxis33';

function nyClock(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { wd: p.weekday, min: (+p.hour % 24) * 60 + +p.minute };
}
const at = (h, m) => h * 60 + m;
const WEEKDAY = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

// Which jobs are due in this 10-minute slot. Called from the */10 cron.
export function dueJobs(scheduledTime) {
  const utcMin = new Date(scheduledTime).getUTCMinutes();
  const { wd, min } = nyClock(scheduledTime);
  const jobs = [];
  // Stock Check's KyberSwap quotes, twice an hour.
  if (utcMin === 10 || utcMin === 40) jobs.push(['base-tools', 'stock-quotes.yml', null]);
  // Navigator's live numbers, every 6 hours as its page says: GitHub's schedule ran them about every 12.
  const utcHour = new Date(scheduledTime).getUTCHours();
  if (utcHour % 6 === 0 && utcMin === 20) jobs.push(['base-tools', 'nav-live.yml', null]);
  // Night Shift: the day's close and after-hours, once after-hours end (20:00 New York).
  if (WEEKDAY.includes(wd) && min === at(20, 20)) jobs.push(['night-shift', 'data.yml', { job: 'closes' }]);
  // Monday check: the night record twice before the bell (the later one wins), the open twice after it.
  if (wd === 'Mon' && (min === at(8, 40) || min === at(9, 10))) jobs.push(['night-shift', 'data.yml', { job: 'night' }]);
  if (wd === 'Mon' && (min === at(9, 40) || min === at(10, 0))) jobs.push(['night-shift', 'data.yml', { job: 'open' }]);
  return jobs;
}

export async function runDueJobs(env, scheduledTime) {
  const jobs = dueJobs(scheduledTime);
  if (!jobs.length) return { jobs: 0 };
  if (!env.GH_DISPATCH_TOKEN) return { jobs: jobs.length, skipped: 'no GH_DISPATCH_TOKEN secret' };
  const out = [];
  for (const [repo, wf, inputs] of jobs) {
    const r = await fetch(`${GH}/${repo}/actions/workflows/${wf}/dispatches`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`, accept: 'application/vnd.github+json', 'user-agent': 'deftools-check', 'x-github-api-version': '2022-11-28' },
      body: JSON.stringify({ ref: 'main', ...(inputs ? { inputs } : {}) }),
    });
    out.push(`${repo}/${wf}${inputs ? ':' + inputs.job : ''} ${r.status}`); // 204 = started
  }
  return out;
}
