#!/usr/bin/env python3
import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request


DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-pro"
DEFAULT_DEEPSEEK_URL = "https://api.deepseek.com/chat/completions"
MAX_DRAFT_CHARS = 240
SEMANTIC_SKIP_TOKEN = "XRADAR_SKIP"
REPORT_UNAVAILABLE_STEPS = {
    "REPORT_WAIT",
    "REPORT_CLICK",
    "TAB_SELECT",
    "REPORT_EXTRACT",
}
REPORT_UNAVAILABLE_TOKENS = [
    "REPORT_NO_GROWABLE_SEED",
    "REPORT_CARD_TIMEOUT",
    "REPORT_CARD_NOT_FOUND",
    "REPORT_DETAIL_NOT_OPENED",
    "REPORT_TEXT_NOT_READY",
    "REPORT_TEXT_EMPTY",
    "did not find a growable seed",
    "timed out waiting for report card",
    "could not find generated report card",
    "report card did not open",
    "report page text is empty",
    "report page text was not fully loaded",
    "x-radar sprout-report did not finish",
]
TRANSIENT_PICK_FAILURE_TOKENS = [
    "OPENCLI_FAILED",
    "timed out",
    "timeout",
    "daemon",
    "bridge",
    "extension",
    "chrome",
    "opencli",
    "connection",
]
DEEPSEEK_SYSTEM_PROMPT = """你是一个擅长写高赞社交媒体回复的内容策略师，也是一个极度看重 ROI（投资回报率）的运营操盘手。

我会给你两类输入：

原推文：需要回复的核心内容。
发散材料（选填）：可能包含案例、类比、金句、历史故事、个人洞察等。
你的任务： 先对原推文进行“价值过滤”，判断其是否值得回复。 如果值得，再根据推文类型生成高赞回复；如果不值得，直接丢弃。

【思考步骤】

第一步：价值过滤（Worthiness Check） 基于以下标准，严格判断原推文是否具备回复价值：

【拒绝回复（SKIP）的标准】：信息密度趋近于零。
纯情绪发泄或无意义的感叹（如：“今天好累”、“啊啊啊啊啊”、“😭”）。
早安/晚安/打卡等毫无信息量的日常问候。
过于私人的闭环对话（如博主和其特定朋友的私事），外人无法插嘴。
判断逻辑：这类推文无法为你提供提供“实用价值”或建立“认知落差”的支点。强行回复会显得像蹭流量的机器人，破坏账号“人感”。
【值得回复（REPLY）的标准】：有借力空间。
提出了具体的观点、行业观察或价值观。
描述了具体的困惑、痛点或社会现象。
发起了具体的提问、调查或资源分享。
如果原推文符合【拒绝回复】标准，或者你判断回复它无法为你带来任何专业度展现或有效流量，请立即停止思考，仅输出特定的字符串：XRADAR_SKIP。

第二步：识别原推文类型（分流机制） （仅在第一步判断为“值得回复”时执行此步） 分析原推文属于以下哪种类型：

A. 观点/洞察类：原推文在表达某种深刻的见解、行业分析或价值观。
B. 互动/调查类：原推文在征集意见、做调查、推荐工具或提供资源。
C. 痛点/现象类：原推文描述了一个具体的困境、焦虑或引起共鸣的生活切片。
第三步：匹配回复策略与发散材料的使用

如果是 A类（观点/洞察）：必须使用发散材料。对原推文进行「压缩、升维、转译」，提炼1个底层原则，落到一句锋利的判断，制造“认知落差”。
如果是 B类（互动/调查）：绝对不要强行升维或讲大道理！ 回复策略为“直接响应诉求 + 提供实用价值”。如果发散材料里刚好有具体的选项/工具，直接提取；如果发散材料无关，则直接忽略。语气要像真实的圈内人。
如果是 C类（痛点/现象）：策略是“共情 + 个人微小视角的解法”。利用发散材料中的案例或原则，给出一个有温度、能唤醒情绪的新视角。
第四步：执行写作要求

字符数控制在 240 个以内。
只输出最终回复，不要复述原推文。
语气要像真实人在 X/Twitter 上回复，带有真实的“UGC感”。
避免空泛词：深度、边界、智慧、清醒、赋能、范式。
优先生成英文回复；如果原推文是中文，则生成中文。
不要写成AI味很重的“这让我想到”或“从A到B”。

【输出格式】 只输出最终生成的回复文本（或"XRADAR_SKIP"），绝对不要输出任何思考过程和类型判断解释。"""


def eprint(message):
    print(message, file=sys.stderr)


def atomic_write_json(path, data):
    directory = os.path.dirname(os.path.abspath(path)) or "."
    os.makedirs(directory, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(
        dir=directory,
        prefix=f".{os.path.basename(path)}.",
        suffix=".tmp",
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.write("\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, path)
    finally:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)


def load_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def run_cmd(args, timeout=None):
    effective_timeout = None if timeout is None or float(timeout) <= 0 else timeout
    res = subprocess.run(
        args,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=effective_timeout,
    )
    return res.returncode, res.stdout.strip(), res.stderr.strip()


def parse_json_output(stdout, command_name):
    try:
        return json.loads(stdout)
    except Exception as exc:
        raise RuntimeError(f"{command_name} returned non-JSON output: {exc}. Output: {stdout[:500]}") from exc


def classify_failure(reason):
    text = str(reason or "").lower()
    if any(token in text for token in [
        "quote_composer_not_found",
        "quote composer",
        "target_url_mismatch",
        "final breaker",
        "repost",
        "post button",
        "selector",
        "toast",
        "x-radar quote-post",
    ]):
        return "EXTERNAL_SERVICE_OR_BROWSER"
    if any(token in text for token in [
        "timed out",
        "timeout",
        "network",
        "connection",
        "connreset",
        "econnreset",
        "enotfound",
        "dns",
        "temporarily unavailable",
        "deepseek api http",
        "deepseek api request failed",
        "urlopen",
        "ssl",
    ]):
        return "NETWORK_OR_TIMEOUT"
    if any(token in text for token in [
        "cluster_seeds.json",
        "active_task.json",
        "missing",
        "damaged",
        "non-json",
        "json",
        "status",
        "state",
    ]):
        return "DATA_OR_STATE"
    if any(token in text for token in [
        "x-radar pick",
        "x-radar sprout-report",
        "getnote",
        "opencli",
        "browser",
        "chrome",
        "x platform",
        "biji",
        "report",
    ]):
        return "EXTERNAL_SERVICE_OR_BROWSER"
    return "CODE_OR_UNEXPECTED"


def require_cluster_seeds(seeds_path):
    if not os.path.exists(seeds_path):
        raise RuntimeError(f"cluster_seeds.json not found: {seeds_path}")
    try:
        seeds = load_json(seeds_path)
    except Exception as exc:
        raise RuntimeError(f"cluster_seeds.json is damaged: {exc}") from exc

    flow = seeds.get("flow_control")
    if not isinstance(flow, dict):
        raise RuntimeError("cluster_seeds.json is missing flow_control")
    for key in [
        "daily_quota_max",
        "current_epoch_count",
        "success_quota_max",
        "current_success_count",
        "last_reset_timestamp",
    ]:
        if key not in flow:
            raise RuntimeError(f"cluster_seeds.json flow_control is missing {key}")
    seeds.setdefault("seen_status_urls", [])
    seeds.setdefault("failed_status_urls", [])
    seeds.setdefault("posted_records", [])
    seeds.setdefault("failed_records", [])
    return seeds


def audit_and_consume_quota(seeds_path):
    seeds = require_cluster_seeds(seeds_path)
    flow = seeds["flow_control"]
    current_ts = int(time.time())
    last_reset = int(flow.get("last_reset_timestamp") or 0)
    delta_reset = current_ts - last_reset

    if last_reset == 0 or delta_reset >= 86400:
        flow["current_epoch_count"] = 0
        flow["current_success_count"] = 0
        flow["last_reset_timestamp"] = current_ts
        atomic_write_json(seeds_path, seeds)

    current_epoch_count = int(flow.get("current_epoch_count") or 0)
    daily_quota_max = int(flow.get("daily_quota_max") or 45)
    current_success_count = int(flow.get("current_success_count") or 0)
    success_quota_max = int(flow.get("success_quota_max") or 15)

    if current_epoch_count >= daily_quota_max:
        print(f"[ABORT] 探测通量超限 ({current_epoch_count}/{daily_quota_max})，本轮挂起。")
        return False
    if current_success_count >= success_quota_max:
        print(f"[ABORT] 成功发帖通量已饱和 ({current_success_count}/{success_quota_max})，本轮挂起。")
        return False

    flow["current_epoch_count"] = current_epoch_count + 1
    atomic_write_json(seeds_path, seeds)
    print(f"[PROCEED] 配额通过，current_epoch_count={flow['current_epoch_count']}")
    return True


def load_task(task_path):
    if not os.path.exists(task_path):
        return None
    try:
        return load_json(task_path)
    except Exception as exc:
        raise RuntimeError(f"active_task.json is damaged: {exc}") from exc


def save_task(task_path, task):
    atomic_write_json(task_path, task)


def normalize_deepseek_content(content):
    return str(content or "").strip().strip('"').strip("'").strip()


def is_semantic_skip(content):
    return normalize_deepseek_content(content) == SEMANTIC_SKIP_TOKEN


def is_report_unavailable(reason, task=None):
    text = str(reason or "")
    lowered = text.lower()
    failed_step = str((task or {}).get("failed_step") or "")
    if failed_step in REPORT_UNAVAILABLE_STEPS:
        return True
    return any(token.lower() in lowered for token in REPORT_UNAVAILABLE_TOKENS)


def is_transient_pick_failure(reason):
    text = str(reason or "").lower()
    return any(token.lower() in text for token in TRANSIENT_PICK_FAILURE_TOKENS)


def extract_note_id(saved):
    return (
        saved.get("note_id")
        or saved.get("id")
        or saved.get("data", {}).get("note_id")
        or saved.get("data", {}).get("id")
        or saved.get("data", {}).get("note", {}).get("note_id")
        or saved.get("data", {}).get("note", {}).get("id")
    )


def mark_report_unavailable(task, reason):
    next_task = dict(task or {})
    for key in [
        "report_text",
        "report_raw_text",
        "report_text_source",
        "report_title",
        "failed_step",
        "error_message",
        "failed_at",
    ]:
        next_task.pop(key, None)
    next_task["status"] = "REPORT_UNAVAILABLE"
    next_task["sprout_report_missing_reason"] = str(reason or "REPORT_UNAVAILABLE")[:1000]
    return next_task


def record_semantic_skip(seeds_path, task_path, task, model):
    seeds = require_cluster_seeds(seeds_path)
    target_url = str(task.get("target_url") or "").strip()
    if target_url:
        seen_urls = seeds.setdefault("seen_status_urls", [])
        if target_url not in seen_urls:
            seen_urls.append(target_url)
    seeds.setdefault("semantic_skipped_records", []).append({
        "url": target_url or None,
        "target_url": target_url or None,
        "reason": "DEEPSEEK_SEMANTIC_SKIP",
        "skip_token": SEMANTIC_SKIP_TOKEN,
        "model": model,
        "ts": int(time.time()),
        "tweet_text": str(task.get("tweet_text") or ""),
    })
    atomic_write_json(seeds_path, seeds)

    task["status"] = "SEMANTIC_SKIPPED"
    task["semantic_skip_reason"] = "DEEPSEEK_SEMANTIC_SKIP"
    task["semantic_skip_token"] = SEMANTIC_SKIP_TOKEN
    save_task(task_path, task)
    if os.path.exists(task_path):
        os.remove(task_path)


def abort_pipeline(seeds_path, task_path, reason, stage, target_url=None):
    eprint(f"[FAILED] {stage}: {reason}")
    task_snapshot = None
    if os.path.exists(task_path):
        try:
            task_snapshot = load_json(task_path)
        except Exception as exc:
            task_snapshot = {"snapshot_error": str(exc)}

    record_url = target_url or (task_snapshot or {}).get("target_url")
    if os.path.exists(seeds_path):
        try:
            seeds = require_cluster_seeds(seeds_path)
            if record_url:
                failed_urls = seeds.setdefault("failed_status_urls", [])
                if record_url not in failed_urls:
                    failed_urls.append(record_url)
            seeds.setdefault("failed_records", []).append({
                "url": record_url,
                "target_url": record_url,
                "reason": reason,
                "stage": stage,
                "failure_category": classify_failure(reason),
                "ts": int(time.time()),
                "active_task_snapshot": task_snapshot,
            })
            atomic_write_json(seeds_path, seeds)
        except Exception as exc:
            eprint(f"[FAILED] could not write failed_records: {exc}")
    if os.path.exists(task_path):
        os.remove(task_path)
    sys.exit(1)


def ensure_pick(args, state_dir, task_path):
    task = load_task(task_path)
    if task:
        print(f"[RESUME] active_task.json exists, status={task.get('status')}")
        return task

    max_attempts = max(1, int(args.pick_retries or 0) + 1)
    last_reason = None
    for attempt in range(1, max_attempts + 1):
        print(f"[RUN] x-radar pick attempt={attempt}/{max_attempts}")
        try:
            code, stdout, stderr = run_cmd([
                args.x_radar_bin,
                "pick",
                "--state-dir",
                state_dir,
            ], timeout=args.command_timeout)
        except subprocess.TimeoutExpired as exc:
            stdout = (exc.stdout or "").strip() if isinstance(exc.stdout, str) else ""
            stderr = (exc.stderr or "").strip() if isinstance(exc.stderr, str) else ""
            code = 124
            last_reason = stderr or stdout or f"x-radar pick timed out after {args.command_timeout}s"
        else:
            last_reason = stderr or stdout or "x-radar pick failed"

        if code == 0:
            result = parse_json_output(stdout, "x-radar pick")
            if result.get("status") != "LOCKED":
                print(f"[IDLE] x-radar pick returned status={result.get('status')}")
                return None
            return load_task(task_path)

        if attempt < max_attempts and is_transient_pick_failure(last_reason):
            print(f"[RETRY] x-radar pick transient failure attempt={attempt}/{max_attempts}: {last_reason[:500]}")
            time.sleep(max(0, float(args.pick_retry_delay or 0)))
            continue
        break

    raise RuntimeError(f"x-radar pick failed after {max_attempts} attempt(s): {last_reason}")


def save_with_getnote(args, task, task_path):
    if task.get("status") != "LOCKED":
        return task

    target_url = str(task.get("target_url") or "").strip()
    if not target_url:
        raise RuntimeError("active_task.json is missing target_url")

    print("[RUN] getnote save")
    try:
        code, stdout, stderr = run_cmd([args.getnote_bin, "save", target_url, "-o", "json"], timeout=args.getnote_timeout)
    except subprocess.TimeoutExpired as exc:
        stdout = (exc.stdout or "").strip() if isinstance(exc.stdout, str) else ""
        stderr = (exc.stderr or "").strip() if isinstance(exc.stderr, str) else ""
        code = 124
        reason = stderr or stdout or f"getnote save timed out after {args.getnote_timeout}s"
    else:
        reason = stderr or stdout or "getnote save failed"

    saved = None
    note_id = None
    if code == 0:
        saved = parse_json_output(stdout, "getnote save")
        note_id = extract_note_id(saved)
        if not note_id:
            reason = f"getnote save JSON did not include note_id: {stdout[:500]}"

    if not note_id:
        raise RuntimeError(reason)

    task["note_id"] = str(note_id)
    task["note_url"] = f"https://www.biji.com/note/{note_id}"
    task["getnote_save_result"] = saved
    task["status"] = "NOTE_SAVED"
    save_task(task_path, task)
    return task


def run_sprout_report(args, state_dir, task_path):
    task = load_task(task_path)
    if not task:
        raise RuntimeError("active_task.json disappeared before sprout-report")
    if task.get("status") not in ("NOTE_SAVED", "SPROUTING"):
        return task

    print("[RUN] x-radar sprout-report")
    code, stdout, stderr = run_cmd([args.x_radar_bin, "sprout-report", "--state-dir", state_dir], timeout=args.sprout_timeout)
    if code != 0:
        reason = stderr or stdout or "x-radar sprout-report failed"
        latest_task = load_task(task_path) or task
        if is_report_unavailable(reason, latest_task):
            fallback = mark_report_unavailable(latest_task, reason)
            save_task(task_path, fallback)
            print(f"[WARN] sprout report unavailable; continuing without report material: {fallback['sprout_report_missing_reason']}")
            return fallback
        raise RuntimeError(reason)
    result = parse_json_output(stdout, "x-radar sprout-report")
    if result.get("status") != "REPORT_READY":
        reason = f"x-radar sprout-report did not finish: {stdout[:500]}"
        latest_task = load_task(task_path) or task
        if is_report_unavailable(reason, latest_task):
            fallback = mark_report_unavailable(latest_task, reason)
            save_task(task_path, fallback)
            print(f"[WARN] sprout report unavailable; continuing without report material: {fallback['sprout_report_missing_reason']}")
            return fallback
        raise RuntimeError(reason)
    return load_task(task_path)


def call_deepseek(args, tweet_text, report_text):
    api_key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("DEEPSEEK_API_KEY is not set")

    payload = {
        "model": args.deepseek_model,
        "messages": [
            {
                "role": "system",
                "content": DEEPSEEK_SYSTEM_PROMPT,
            },
            {
                "role": "user",
                "content": (
                    f"原推文：\n{tweet_text}\n\n"
                    f"发散材料：\n{report_text}"
                ),
            },
        ],
        "thinking": {"type": "enabled"},
        "reasoning_effort": "high",
        "stream": False,
    }
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        args.deepseek_url,
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=args.deepseek_timeout) as res:
            raw = res.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"DeepSeek API HTTP {exc.code}: {detail[:1000]}") from exc
    except Exception as exc:
        raise RuntimeError(f"DeepSeek API request failed: {exc}") from exc

    data = parse_json_output(raw, "DeepSeek API")
    content = normalize_deepseek_content(data.get("choices", [{}])[0].get("message", {}).get("content") or "")
    if not content:
        raise RuntimeError(f"DeepSeek API returned empty content: {raw[:1000]}")
    if not is_semantic_skip(content) and len(content) > MAX_DRAFT_CHARS:
        content = content[:MAX_DRAFT_CHARS].rstrip()
    if not content:
        raise RuntimeError("DeepSeek draft_reply became empty after trimming")
    return content, data


def generate_content(args, seeds_path, task, task_path):
    if task.get("status") not in ("REPORT_READY", "REPORT_UNAVAILABLE"):
        return task

    tweet_text = str(task.get("tweet_text") or "").strip()
    report_text = str(task.get("report_text") or task.get("report_raw_text") or "").strip()
    if not tweet_text:
        raise RuntimeError("active_task.json is missing tweet_text for DeepSeek")

    print(f"[RUN] DeepSeek {args.deepseek_model}")
    draft, raw = call_deepseek(args, tweet_text, report_text)
    if is_semantic_skip(draft):
        task["deepseek_model"] = args.deepseek_model
        task["deepseek_result"] = raw
        record_semantic_skip(seeds_path, task_path, task, args.deepseek_model)
        print("[SKIP] DeepSeek returned XRADAR_SKIP; task discarded without posting.")
        return None

    task["draft_reply"] = draft
    task["draft_reply_char_count"] = len(draft)
    task["deepseek_model"] = args.deepseek_model
    task["deepseek_result"] = raw
    task["status"] = "CONTENT_READY"
    save_task(task_path, task)
    print(f"[READY] draft_reply chars={len(draft)}")
    return task


def run_quote_post(args, state_dir, task_path):
    task = load_task(task_path)
    if not task:
        raise RuntimeError("active_task.json disappeared before quote-post")
    if task.get("status") != "CONTENT_READY":
        return

    print("[RUN] x-radar quote-post")
    code, stdout, stderr = run_cmd([args.x_radar_bin, "quote-post", "--state-dir", state_dir], timeout=args.quote_timeout)
    if code != 0:
        raise RuntimeError(stderr or stdout or "x-radar quote-post failed")
    result = parse_json_output(stdout, "x-radar quote-post")
    if result.get("status") != "POSTED":
        raise RuntimeError(f"x-radar quote-post did not finish: {stdout[:500]}")
    if os.path.exists(task_path):
        raise RuntimeError("x-radar quote-post returned success but active_task.json still exists")


def parse_args():
    parser = argparse.ArgumentParser(description="Run the full X Radar automation pipeline.")
    parser.add_argument("--state-dir", default=os.environ.get("X_RADAR_STATE_DIR", "."))
    parser.add_argument("--x-radar-bin", default=os.environ.get("X_RADAR_BIN", "x-radar"))
    parser.add_argument("--getnote-bin", default=os.environ.get("GETNOTE_BIN", "getnote"))
    parser.add_argument("--deepseek-model", default=os.environ.get("DEEPSEEK_MODEL", DEFAULT_DEEPSEEK_MODEL))
    parser.add_argument("--deepseek-url", default=os.environ.get("DEEPSEEK_URL", DEFAULT_DEEPSEEK_URL))
    parser.add_argument("--command-timeout", type=int, default=180)
    parser.add_argument("--sprout-timeout", type=int, default=900)
    parser.add_argument("--quote-timeout", type=int, default=240)
    parser.add_argument("--deepseek-timeout", type=int, default=120)
    parser.add_argument("--pick-retries", type=int, default=2)
    parser.add_argument("--pick-retry-delay", type=float, default=3)
    parser.add_argument("--pre-x-jitter-min", type=float, default=0, help=argparse.SUPPRESS)
    parser.add_argument("--pre-x-jitter-max", type=float, default=0, help=argparse.SUPPRESS)
    parser.add_argument("--getnote-timeout", type=int, default=0)
    return parser.parse_args()


def main():
    args = parse_args()
    state_dir = os.path.abspath(args.state_dir)
    seeds_path = os.path.join(state_dir, "cluster_seeds.json")
    task_path = os.path.join(state_dir, "active_task.json")
    os.makedirs(state_dir, exist_ok=True)

    try:
        if not audit_and_consume_quota(seeds_path):
            return 0

        try:
            task = ensure_pick(args, state_dir, task_path)
            if task is None:
                return 0

            target_url = task.get("target_url")
            task = save_with_getnote(args, task, task_path)
            task = run_sprout_report(args, state_dir, task_path)
            task = generate_content(args, seeds_path, task, task_path)
            if task is None:
                print("[DONE] 本轮推文被语义过滤跳过。")
                return 0
            run_quote_post(args, state_dir, task_path)
        except Exception as exc:
            failed_task = load_task(task_path)
            target_url = (failed_task or {}).get("target_url")
            stage = "PIPELINE" if target_url else "PICK"
            abort_pipeline(seeds_path, task_path, str(exc), stage, target_url)

        print("[DONE] 全闭环自动化工作流完成。")
        return 0
    except Exception as exc:
        eprint(f"[CRITICAL] {exc}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
