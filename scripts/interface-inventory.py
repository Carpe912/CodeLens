#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把 CodeLens 的 url_patterns 明细还原成「真实 HTTP 接口清单」。

背景：/repos/:id/stats 只返回接口「数量」，而 url_patterns 本身不可读——
  * normalized_pattern 里保留了基底 helper 的**实参名**（`${URL(aid)}/delete`
    与 `${URL(option.aid)}/delete` 被算成两行，其实是同一个接口）；
  * 有 39 行 method 为 NULL，混着前端路由、构建产物、界面文案与真实接口。

本脚本：
  1. 读入 url_patterns 的 JSONL 明细（由 /tmp/url-dump.sql 导出）；
  2. 按源码里各 base.ts / service 的 helper 定义，把 `${HELPER(x)}` 展开成真实前缀；
  3. 归一成 (method, 真实路径) 并去重；
  4. 把 method 为 NULL 的行按证据分类（前端路由 / 构建产物 / 界面文案 / 真实路径）；
  5. 输出 HTML（可筛选）/ CSV / JSON 三份清单。

用法：
  python3 scripts/interface-inventory.py <urls.jsonl> <outdir> [--repo-name NAME]
"""

import sys, os, re, json, csv, html, collections

# ---------------------------------------------------------------------------
# 1. helper -> 真实前缀。带 {appId} 等占位符，与原定义一一对应。
#    GLOBAL：无论定义在哪个文件都成立。FILE_SCOPED：同名 helper 在不同文件里
#    含义不同（如 `URL`、`scope`、`scoped`），必须结合 def_file 判定。
# ---------------------------------------------------------------------------
GLOBAL_HELPERS = {
    "COOP_URL": "/rest",
    "GLOBAL_URL": "/rest/global",
    "ACCOUNT_URL": "/rest/account",
    "PREFERENCE_URL": "/rest/global/preference",
    "QUALITY_PLAYWRIGHT_API": "/rest/quality/playwright/api",
    "OPEN_TESTWIRE_URL": "/rest/open/testwire",
    "TEST_URL_PTRFIX": "/plugin",
    "TEST_URL_API": "/plugin/api",
    "PLATFORM_AUDIT": "/rest/platform/audit",
    "QUALITY_URL": "/rest/quality/a/{appId}",
    "PROJECT_URL": "/rest/project/p/{projectId}",
    "PROJECT_APP_URL": "/rest/project/a/{appId}",
    "APPLICATION_URL": "/rest/project/a/{appId}/application",
    "CASE_URL": "/rest/quality/a/{appId}/api/case",
    "ENV_URL": "/rest/quality/a/{appId}/api/env/setting",
    "scenarioScoped": "/rest/quality/a/{appId}/api/scenario",
    "TEST_ENVIRONMENT_URL": "/rest/quality/a/{appId}/testEnvironment",
    "uiStepScoped": "/rest/quality/a/{appId}/uiStep",
    "EXECUTE_URL": "/rest/quality/a/{appId}/api/test/execute",
    "PREFIX": "/rest/investigate/{pid}/interfaceDesign",
    "PLUGIN_URL": "/plugin",
}

# def_file 后缀 -> { helper 名 -> 真实前缀 }
# `scope` / `URL` / `scoped` 在同名文件里含义不同，必须按文件判定。
# 下列映射逐行核对自源码（`grep -rnE '^\s*(export )?(const|function) (scope|URL|scoped)\s*[=(]'`）。
BASE_QUALITY = "/rest/quality/a/{appId}"
FILE_SCOPED_HELPERS = {
    # URL(appId) —— 每个 service 目录各自定义一次
    "src/service/Api/ApiDefinition/index.ts": {"URL": BASE_QUALITY + "/apiDefinition"},
    "src/service/Api/ApiGroup/index.ts": {"URL": BASE_QUALITY + "/apiGroup"},
    "src/service/Api/Setting/index.ts": {"URL": BASE_QUALITY + "/api/test/setting"},
    "src/service/Api/StepProcessingRuleService/index.ts": {"URL": BASE_QUALITY + "/api/test/setting"},
    # scope(appId) —— 14 处同名定义，前缀互不相同
    "src/service/Api/TestScenario/index.ts": {"scope": BASE_QUALITY},
    "src/service/Api/TestScenario/detail.ts": {"scope": BASE_QUALITY},
    "src/service/Api/TestScenario/step.ts": {"scope": BASE_QUALITY},
    "src/service/Api/TestScenario/snapshot.ts": {"scope": BASE_QUALITY + "/api/scenario"},
    "src/service/Api/TestScenario/snapshotDetail.ts": {"scope": BASE_QUALITY + "/api/scenario"},
    "src/service/Api/TestScenario/runtimeSetting.ts": {"scope": BASE_QUALITY + "/api/scenario"},
    "src/service/Api/TestScenarioReport/index.ts": {"scope": BASE_QUALITY + "/api/report"},
    "src/service/Api/TimedTask/index.ts": {"scope": BASE_QUALITY},
    "src/service/Api/TimedTask/TimedTaskReportService.ts": {"scope": BASE_QUALITY + "/api/report"},
    "src/service/Api/TimedTask/TimedTaskBatchReportService.ts": {"scope": BASE_QUALITY + "/api/report"},
    "src/service/Api/TestScenarioGroup/index.ts": {"scope": BASE_QUALITY + "/api/scenario"},
    "src/service/Api/TestScenarioGroup/BuiltInTress.ts": {"scope": BASE_QUALITY + "/api/scenario"},
    "src/service/Api/TestScenarioData/index.ts": {"scope": BASE_QUALITY + "/api/test/data"},
    "src/service/Api/TestScenarioExecute/index.ts": {"scope": "/plugin/api/log"},
    # scoped(appId) / scoped
    "src/service/Api/Edition/index.ts": {"scoped": BASE_QUALITY},
    "src/service/Api/plugin/index.ts": {"scoped": "/plugin/web/plugin"},
}

LEAD_HELPER = re.compile(r"^\$\{\s*([A-Za-z_$][\w$]*)\s*(?:\()?")
PLACEHOLDER = re.compile(r"\$\{[^}]*\}")


# 变量名（不是 helper）：URL 来自运行时计算，静态无法展开
DYNAMIC_NAMES = {"url", "uri", "href", "link"}


def resolve_prefix(pattern, def_file):
    """把 pattern 开头的 `${HELPER(...)}` 换成真实前缀，返回 (前缀, 剩余, 是否已解析)。"""
    m = LEAD_HELPER.match(pattern)
    if not m:
        # 不以 ${ 开头：要么是绝对路径，要么是不带前导斜杠的相对路径
        # （相对路径由 axios baseURL 解析，见 src/service/Axios/base.ts）
        if "/" in pattern:
            return "", pattern, True
        return "", pattern, False
    name = m.group(1)
    if name in DYNAMIC_NAMES:
        return "", pattern, False
    # file-scoped 优先
    for f, table in FILE_SCOPED_HELPERS.items():
        if def_file.endswith(f) and name in table:
            rest = pattern[m.end():]
            rest = re.sub(r"^[^}]*\}\s*", "", rest)  # 吃掉 helper 的实参括号与 }
            return table[name], rest, True
    if name in GLOBAL_HELPERS:
        rest = pattern[m.end():]
        rest = re.sub(r"^[^}]*\}\s*", "", rest)
        return GLOBAL_HELPERS[name], rest, True
    return "", pattern, False


def normalize_tail(tail):
    """把剩余部分的 ${...} 变成 :param，去掉查询串与结尾斜杠。"""
    t = PLACEHOLDER.sub(":param", tail)
    t = t.split("?")[0]
    t = re.sub(r"/+$", "", t)
    if t and not t.startswith("/"):
        t = "/" + t
    return t


def real_path(pattern, def_file):
    """返回 (真实路径 或 None, 是否解析成功)。"""
    prefix, tail, ok = resolve_prefix(pattern, def_file)
    if not ok:
        if pattern.startswith("http"):
            return pattern, True          # 外部绝对 URL，本身就是完整地址
        return None, False
    if pattern.startswith("http"):
        return pattern, True
    return (prefix + normalize_tail(tail)), True


# ---------------------------------------------------------------------------
# 2. method=NULL 行的分类规则（每条都基于 def_code / def_file 的证据）
# ---------------------------------------------------------------------------
def classify_null(row):
    code = (row.get("def_code") or "").strip()
    f = row.get("def_file") or ""
    if code.startswith("path:"):
        return "前端路由（Vue Router / 菜单树）", False
    if f.endswith("vite.config.ts") or f.endswith("vite.config.js"):
        return "构建产物 / 路径别名（vite.config）", False
    if code.startswith("label:"):
        return "界面文案", False
    if "monaco" in row["normalized"]:
        return "第三方静态资源", False
    return "真实路径（未能判定 method）", True


# 通用请求封装：`src/service/index.ts` 的 WrapAxios 把 url 当参数收进来，
# 它自己的 axios.get(url) 不是任何一个具体接口，属于管道本身。
PLUMBING_FILES = ("src/service/index.ts",)


def is_plumbing(row):
    return any((row.get("def_file") or "").endswith(p) for p in PLUMBING_FILES)


# ---------------------------------------------------------------------------
def main():
    src = sys.argv[1]
    outdir = sys.argv[2]
    repo_name = "repo"
    if "--repo-name" in sys.argv:
        repo_name = sys.argv[sys.argv.index("--repo-name") + 1]
    os.makedirs(outdir, exist_ok=True)

    rows = [json.loads(l) for l in open(src, encoding="utf-8") if l.strip().startswith("{")]

    interfaces = []      # method-ful
    nulls = []           # method-less
    unresolved = []
    plumbing = []        # 通用请求封装自身，不是具体接口

    for r in rows:
        if r["method"]:
            if is_plumbing(r):
                r["kind"] = "通用请求封装（WrapAxios 本身）"
                plumbing.append(r)
                continue
            rp, ok = real_path(r["pattern"], r["def_file"])
            r["real_path"] = rp
            if not ok:
                unresolved.append(r)
            interfaces.append(r)
        else:
            kind, is_real = classify_null(r)
            r["kind"] = kind
            r["is_real"] = is_real
            nulls.append(r)

    # 去重：同一 (method, real_path) 只保留一行，合并调用点信息
    merged = collections.OrderedDict()
    for r in interfaces:
        key = (r["method"], r["real_path"] or r["pattern"])
        if key not in merged:
            merged[key] = {
                "method": r["method"],
                "real_path": r["real_path"] or r["pattern"],
                "raw_patterns": [],
                "defs": [],
                "usages": 0,
                "files": set(),
                "resolved": r["real_path"] is not None,
            }
        m = merged[key]
        m["raw_patterns"].append(r["pattern"])
        m["defs"].append(f'{r["def_file"]}:{r["def_line"]}')
        m["usages"] += r["usages"] or 0
        for p in (r.get("usage_files") or []):
            m["files"].add(p)

    deduped = list(merged.values())
    for d in deduped:
        d["raw_patterns"] = sorted(set(d["raw_patterns"]))
        d["defs"] = sorted(set(d["defs"]))
        d["files"] = sorted(d["files"])
    deduped.sort(key=lambda d: (d["method"], d["real_path"]))

    # ---- CSV ----
    csv_path = os.path.join(outdir, f"{repo_name}-interfaces.csv")
    with open(csv_path, "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.writer(fh)
        w.writerow(["method", "real_path", "raw_pattern", "definition", "usage_count", "usage_files"])
        for d in deduped:
            w.writerow([d["method"], d["real_path"], " | ".join(d["raw_patterns"]),
                        " | ".join(d["defs"]), d["usages"], " | ".join(d["files"])])

    # ---- JSON ----
    json_path = os.path.join(outdir, f"{repo_name}-interfaces.json")
    with open(json_path, "w", encoding="utf-8") as fh:
        json.dump({"repo": repo_name, "raw_rows": len(rows),
                   "interfaces": deduped,
                   "non_interfaces": nulls,
                   "plumbing": plumbing,
                   "unresolved": unresolved}, fh, ensure_ascii=False, indent=1)

    # ---- 统计 ----
    def backend_of(p):
        if p is None:
            return "未解析"
        if p.startswith("http"):
            return "外部绝对 URL"
        seg = p.strip("/").split("/")
        return seg[0] if seg and seg[0] else "根路径"

    by_method = collections.Counter(d["method"] for d in deduped)
    by_backend = collections.Counter(backend_of(d["real_path"]) for d in deduped)
    null_kinds = collections.Counter(d["kind"] for d in nulls)

    stats = {
        "raw_rows": len(rows),
        "with_method_rows": len(interfaces) + len(plumbing),
        "distinct_interfaces": len(deduped),
        "merged_away": len(interfaces) - len(deduped),
        "null_rows": len(nulls),
        "plumbing_rows": len(plumbing),
        "unresolved": len(unresolved),
        "by_method": dict(by_method),
        "by_backend": dict(by_backend),
        "null_kinds": dict(null_kinds),
    }

    # ---- HTML ----
    html_path = os.path.join(outdir, f"{repo_name}-interfaces.html")
    payload = json.dumps({"rows": deduped, "nulls": nulls, "stats": stats,
                          "repo": repo_name}, ensure_ascii=False)
    open(html_path, "w", encoding="utf-8").write(HTML_TEMPLATE.replace("__DATA__", payload))

    print(json.dumps(stats, ensure_ascii=False, indent=1))
    print("\n[written]", csv_path)
    print("[written]", json_path)
    print("[written]", html_path)


HTML_TEMPLATE = r"""<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CodeLens · 真实 HTTP 接口清单</title>
<style>
:root{--bg:#0d1117;--panel:#161b22;--line:#30363d;--fg:#e6edf3;--dim:#8b949e;
--post:#d29922;--get:#3fb950;--put:#58a6ff;--del:#f85149;--acc:#a371f7}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.6 -apple-system,"Segoe UI","PingFang SC",sans-serif}
header{padding:22px 26px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg);z-index:5}
h1{margin:0 0 6px;font-size:17px;font-weight:600}
.sub{color:var(--dim);font-size:12px}
.kpis{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px}
.kpi{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:8px 13px;min-width:104px}
.kpi b{display:block;font-size:19px;line-height:1.25}
.kpi span{color:var(--dim);font-size:11px}
main{padding:18px 26px 60px}
.bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:14px}
button{background:var(--panel);color:var(--fg);border:1px solid var(--line);border-radius:6px;
padding:5px 11px;cursor:pointer;font-size:12px}
button.on{background:#1f6feb;border-color:#1f6feb}
input{background:var(--panel);color:var(--fg);border:1px solid var(--line);border-radius:6px;
padding:6px 10px;width:280px;font-size:12px}
table{width:100%;border-collapse:collapse;background:var(--panel);border-radius:8px;overflow:hidden}
th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{background:#1c2128;font-size:11px;color:var(--dim);text-transform:uppercase;letter-spacing:.04em;
position:sticky;top:112px}
td.p{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;word-break:break-all}
.m{font-weight:700;font-size:11px;padding:1px 7px;border-radius:4px;display:inline-block;min-width:56px;text-align:center}
.POST{background:rgba(210,153,34,.16);color:var(--post)}
.GET{background:rgba(63,185,80,.16);color:var(--get)}
.PUT{background:rgba(88,166,255,.16);color:var(--put)}
.DELETE{background:rgba(248,81,73,.16);color:var(--del)}
.PATCH,.HEAD,.OPTIONS,.FETCH{background:rgba(163,113,247,.16);color:var(--acc)}
.dim{color:var(--dim);font-size:11.5px}
.tag{display:inline-block;background:#21262d;border:1px solid var(--line);border-radius:4px;
padding:0 6px;font-size:11px;color:var(--dim);margin-right:5px}
details{margin-top:34px;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px 16px}
summary{cursor:pointer;font-weight:600;font-size:13px}
.note{color:var(--dim);font-size:12px;margin:10px 0 4px}
</style></head><body>
<header>
  <h1>真实 HTTP 接口清单 · <span id="repo"></span></h1>
  <div class="sub">由 <code>url_patterns</code> 明细还原：基底 helper 已展开为真实前缀，<code>${...}</code> 归一为 <code>:param</code>，同一接口的不同实参写法已合并。</div>
  <div class="kpis" id="kpis"></div>
</header>
<main>
  <div class="bar">
    <input id="q" placeholder="过滤路径 / 文件 / method…">
    <span id="mbtns"></span>
  </div>
  <table><thead><tr>
    <th style="width:74px">Method</th><th>真实路径</th><th style="width:78px">调用点</th>
    <th style="width:34%">定义位置</th><th style="width:20%">原始 pattern</th>
  </tr></thead><tbody id="tb"></tbody></table>

  <details>
    <summary>被排除的 <span id="nnull"></span> 行「method 为空」记录 —— 逐条附出处证据</summary>
    <div class="note">这些行不是 HTTP 接口调用。前端路由来自 Vue Router 配置 / 菜单树；构建产物来自 vite.config；
      界面文案是下拉框 label。<b>它们此前一起被计入了「接口总数」。</b></div>
    <table><thead><tr><th style="width:150px">分类</th><th>值</th>
      <th style="width:32%">出处</th><th style="width:26%">源码证据</th></tr></thead>
      <tbody id="tbnull"></tbody></table>
  </details>
</main>
<script>
const D = __DATA__;
document.getElementById('repo').textContent = D.repo;
const S = D.stats;
document.getElementById('nnull').textContent = S.null_rows;
document.getElementById('kpis').innerHTML = [
  ['真实接口（去重后）', S.distinct_interfaces],
  ['url_patterns 原始行', S.raw_rows],
  ['其中带 method', S.with_method_rows],
  ['method 为空', S.null_rows],
  ['按 method', Object.entries(S.by_method).map(([k,v])=>k+' '+v).join(' · ')],
].map(([k,v])=>`<div class="kpi"><b>${v}</b><span>${k}</span></div>`).join('');

let methodFilter = null, kw = '';
function render(){
  const tb = document.getElementById('tb');
  let rows = D.rows;
  if (methodFilter) rows = rows.filter(r=>r.method===methodFilter);
  if (kw) { const k = kw.toLowerCase();
    rows = rows.filter(r => (r.real_path+' '+r.defs.join(' ')+' '+r.files.join(' ')+' '+r.raw_patterns.join(' ')).toLowerCase().includes(k)); }
  tb.innerHTML = rows.map(r=>`<tr>
    <td><span class="m ${r.method}">${r.method}</span></td>
    <td class="p">${r.real_path}</td>
    <td class="dim">${r.usages}</td>
    <td class="p dim">${r.defs.map(d=>d).join('<br>')}</td>
    <td class="p dim">${r.raw_patterns.join('<br>')}</td>
  </tr>`).join('');
  document.getElementById('cnt').textContent = rows.length;
}
const ms = ['ALL', ...Object.keys(S.by_method)];
document.getElementById('mbtns').innerHTML = ms.map(m=>`<button data-m="${m}" class="${m==='ALL'?'on':''}">${m}</button>`).join(' ')
  + ' <span class="dim">显示 <b id="cnt"></b> 条</span>';
document.getElementById('mbtns').addEventListener('click',e=>{
  const m=e.target.dataset.m; if(!m) return;
  methodFilter = m==='ALL'?null:m;
  [...document.querySelectorAll('#mbtns button')].forEach(b=>b.classList.toggle('on', b.dataset.m===m));
  render();
});
document.getElementById('q').addEventListener('input',e=>{kw=e.target.value;render();});
document.getElementById('tbnull').innerHTML = D.nulls.map(r=>`<tr>
  <td class="dim">${r.kind}</td><td class="p">${r.normalized}</td>
  <td class="p dim">${r.def_file}:${r.def_line}</td>
  <td class="p dim">${(r.def_code||'').replace(/</g,'&lt;')}</td></tr>`).join('');
render();
</script></body></html>
"""

if __name__ == "__main__":
    main()
