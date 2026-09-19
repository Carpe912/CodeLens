#!/usr/bin/env python3
"""
渲染「接口清单」为可读的 HTML/CSV —— 数据来自**线上结构化路由**，不是本地估算。

为什么不用检索式问答：见 apps/api/src/analysis/url-inventory.ts 的文件头。
一句话 —— 「列出所有 N」是集合类问题，top-K 在数学上无法保证完备。

口径（与 GET /repos/:id/url-patterns 完全一致）：
  total               = url_patterns 原始行数
  rows                = 按 (method, realPath) 去重后的行数（含 method 未判定的行）
  distinctInterfaces  = rows 中 method 已判定的那一部分（= 真实接口数）
  未判定              = rows - distinctInterfaces（诊断线索，需人工判定）

用法：
  python3 scripts/render-interface-inventory.py                 # 拉线上
  python3 scripts/render-interface-inventory.py live-inv.json    # 用已导出的 JSON
可选环境变量：
  CODELENS_API  默认 http://47.116.6.132/code-api
  REPO_ID       默认 33
"""
import csv
import json
import os
import sys
import urllib.request
from datetime import datetime, timezone, timedelta
from html import escape

API = os.environ.get("CODELENS_API", "http://47.116.6.132/code-api")
REPO_ID = int(os.environ.get("REPO_ID", "33"))
OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "docs", "api-inventory")

METHOD_ORDER = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]
METHOD_COLOR = {
    "GET": "#4ade80", "POST": "#60a5fa", "PUT": "#fbbf24",
    "DELETE": "#f87171", "PATCH": "#c084fc", "HEAD": "#22d3ee", "OPTIONS": "#94a3b8",
}


def load():
    if len(sys.argv) > 1:
        with open(sys.argv[1], encoding="utf-8") as fh:
            return json.load(fh), f"file:{sys.argv[1]}"
    url = f"{API}/repos/{REPO_ID}/url-patterns"
    with urllib.request.urlopen(url, timeout=90) as resp:
        return json.loads(resp.read().decode("utf-8")), url


# ---------------------------------------------------------------- 未判定行三分类
# 规则写成代码而不是手填，保证可复现、可复核。顺序即优先级。
def triage(row):
    """给 method 未判定的行一个**可复核**的判定：真接口 / 非接口（附原因）。"""
    real = row.get("realPath") or ""
    pat = row.get("pattern") or ""
    f = row.get("definitionFile") or ""

    if real.startswith("http://") or real.startswith("https://"):
        return ("非接口", "外部资源/CDN 地址，不是本项目接口")
    if "vite.config" in f:
        return ("非接口", "vite 构建产物路径（dev server / 输出路径配置）")
    if "router/routes" in f:
        return ("非接口", "前端路由（React/Vue-Router 路径，不是后端接口）")
    if "initializeRootMenu" in f or "AppCreated" in f:
        return ("非接口", "前端菜单/路由动态拼接路径")
    if real == "/Read/Write":
        return ("非接口", "UI 文案（组件里的显示字符串）")
    if real.startswith("/plugin/api/") or real.startswith("/rest/"):
        return ("真接口", "后端接口路径，仅索引器未从调用点推断出 method")
    return ("非接口", "未匹配任何已知特征，需人工判定")


def group_of(row):
    real = row.get("realPath")
    if not real:
        return "未展开（依赖运行时变量，无法静态求得）"
    segs = [s for s in real.split("/") if s]
    if not segs:
        return "其它"
    if segs[0] in ("rest", "plugin") and len(segs) >= 2:
        return "/" + "/".join(segs[:2])
    return "/" + segs[0]


def method_sort_key(r):
    m = r["method"]
    return (1 if m is None else 0, METHOD_ORDER.index(m) if m in METHOD_ORDER else 99,
            (r.get("realPath") or r.get("pattern") or ""))


def write_csv(path, rows):
    with open(path, "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.writer(fh)
        w.writerow(["method", "real_path", "raw_pattern", "normalized_pattern",
                    "definition_file", "definition_line", "usage_count", "usage_files", "triage"])
        for r in rows:
            tag = ""
            if r["method"] is None:
                kind, why = triage(r)
                tag = f"{kind}: {why}"
            w.writerow([r["method"] or "", r.get("realPath") or "", r["pattern"],
                        r.get("normalizedPattern") or "", r.get("definitionFile") or "",
                        r.get("definitionLine") or "", r.get("usageCount") or 0,
                        " ".join(r.get("usageFiles") or []), tag])


def render_html(data, rows, source, generated_at):
    real_rows = [r for r in rows if r["method"] is not None]
    unknown_rows = [r for r in rows if r["method"] is None]

    groups = {}
    for r in real_rows:
        groups.setdefault(group_of(r), []).append(r)
    for g in groups.values():
        g.sort(key=method_sort_key)
    ordered_groups = sorted(groups.items(), key=lambda kv: (-len(kv[1]), kv[0]))

    # 未判定行的三分类统计
    tri = {"真接口": [], "非接口": []}
    for r in unknown_rows:
        kind, why = triage(r)
        tri[kind].append((r, why))

    by_method = data.get("byMethod", {})
    chips = "".join(
        f'<span class="chip"><b style="color:{METHOD_COLOR.get(m, "#94a3b8")}">{escape(m)}</b>'
        f'<span class="num">{n}</span></span>'
        for m, n in sorted(by_method.items(), key=lambda kv: (kv[0] == "(未判定)", kv[0]))
    )

    def row_html(r):
        m = r["method"]
        color = METHOD_COLOR.get(m, "#94a3b8")
        real = r.get("realPath")
        real_txt = escape(real) if real else '<span class="muted">—（无法静态展开）</span>'
        uses = r.get("usageCount") or 0
        uf = r.get("usageFiles") or []
        uf_title = escape(" / ".join(uf)) if uf else ""
        loc = f"{escape(r.get('definitionFile') or '?')}:{r.get('definitionLine') or '?'}"
        return (
            f'<tr data-method="{escape(m or "")}" '
            f'data-key="{escape(((real or "") + " " + (r.get("pattern") or "") + " " + loc).lower())}">'
            f'<td><span class="m" style="color:{color};border-color:{color}33">{escape(m or "")}</span></td>'
            f'<td class="path">{real_txt}</td>'
            f'<td class="raw">{escape(r.get("pattern") or "")}</td>'
            f'<td class="loc">{loc}</td>'
            f'<td class="uses" title="{uf_title}">{uses}</td>'
            f"</tr>"
        )

    sections = []
    for name, grows in ordered_groups:
        body = "\n".join(row_html(r) for r in grows)
        sections.append(
            f'<section class="grp" data-grp="{escape(name.lower())}">'
            f'<h3>{escape(name)} <span class="cnt">{len(grows)}</span></h3>'
            f'<table><thead><tr><th>方法</th><th>真实路径</th><th>源码里的原始写法</th>'
            f'<th>定义位置</th><th>调用点</th></tr></thead><tbody>{body}</tbody></table></section>'
        )

    def unknown_html(r, why):
        real = r.get("realPath")
        real_txt = escape(real) if real else '<span class="muted">—</span>'
        loc = f"{escape(r.get('definitionFile') or '?')}:{r.get('definitionLine') or '?'}"
        return (
            f'<tr><td class="path">{real_txt}</td>'
            f'<td class="raw">{escape(r.get("pattern") or "")}</td>'
            f'<td class="loc">{loc}</td><td class="why">{escape(why)}</td></tr>'
        )

    real_unknown = "\n".join(unknown_html(r, w) for r, w in tri["真接口"])
    fake_unknown = "\n".join(unknown_html(r, w) for r, w in tri["非接口"])

    color_order = [m for m in METHOD_ORDER if m in by_method] + \
                  [m for m in by_method if m not in METHOD_ORDER]

    return f"""<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>接口清单 · repo {data.get('repoId')}</title>
<style>
:root{{--bg:#0d1117;--panel:#161b22;--panel2:#1c2230;--bd:#2d3748;--tx:#e6edf3;--mut:#8b949e;
--acc:#58a6ff;--warn:#f0b429;--ok:#3fb950;--bad:#f85149}}
*{{box-sizing:border-box}}
body{{margin:0;background:var(--bg);color:var(--tx);
font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif}}
header{{padding:26px 32px 20px;border-bottom:1px solid var(--bd);background:linear-gradient(180deg,#161b22,#0d1117)}}
h1{{margin:0 0 6px;font-size:21px;font-weight:650}}
.sub{{color:var(--mut);font-size:12.5px}}
.sub code{{background:#0b0f14;border:1px solid var(--bd);border-radius:4px;padding:1px 5px;font-size:11.5px}}
.cards{{display:flex;gap:12px;flex-wrap:wrap;margin:18px 32px 0}}
.card{{background:var(--panel);border:1px solid var(--bd);border-radius:10px;padding:13px 17px;min-width:132px}}
.card .k{{color:var(--mut);font-size:11.5px;letter-spacing:.02em}}
.card .v{{font-size:25px;font-weight:680;margin-top:3px;font-variant-numeric:tabular-nums}}
.card .n{{color:var(--mut);font-size:11.5px;margin-top:2px}}
.main{{padding:20px 32px 60px}}
.bar{{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:6px 0 18px;
position:sticky;top:0;background:var(--bg);padding:10px 0;z-index:5;border-bottom:1px solid var(--bd)}}
button.mf{{background:var(--panel2);color:var(--tx);border:1px solid var(--bd);border-radius:7px;
padding:6px 13px;cursor:pointer;font-size:12.5px;font-weight:520}}
button.mf:hover{{border-color:#5a6b85}}
button.mf.on{{background:#1f6feb;border-color:#1f6feb;color:#fff}}
input#q{{flex:1;min-width:220px;background:#0b0f14;border:1px solid var(--bd);border-radius:7px;
padding:7px 12px;color:var(--tx);font-size:13px;outline:none}}
input#q:focus{{border-color:var(--acc)}}
#count{{color:var(--mut);font-size:12.5px;font-variant-numeric:tabular-nums}}
.chips{{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px}}
.chip{{background:var(--panel2);border:1px solid var(--bd);border-radius:999px;padding:3px 11px;font-size:12px}}
.chip .num{{color:var(--mut);margin-left:6px;font-variant-numeric:tabular-nums}}
section.grp{{margin:0 0 26px}}
h3{{font-size:14.5px;margin:0 0 9px;color:var(--acc);font-weight:600}}
h3 .cnt{{color:var(--mut);font-weight:400;font-size:12px}}
table{{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--bd);border-radius:9px;overflow:hidden}}
th{{text-align:left;padding:8px 12px;background:var(--panel2);color:var(--mut);font-size:11.5px;
font-weight:560;border-bottom:1px solid var(--bd);white-space:nowrap}}
td{{padding:7px 12px;border-bottom:1px solid #21262d;vertical-align:top}}
tr:last-child td{{border-bottom:none}}
tr:hover td{{background:#1b2230}}
td.path{{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;color:var(--tx);word-break:break-all}}
td.raw{{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;color:var(--mut);word-break:break-all;max-width:330px}}
td.loc{{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--mut);white-space:nowrap}}
td.uses{{text-align:right;color:var(--mut);font-variant-numeric:tabular-nums}}
td.why{{color:var(--warn);font-size:12px}}
.m{{border:1px solid;border-radius:5px;padding:1px 7px;font-size:11px;font-weight:640;letter-spacing:.03em}}
.muted{{color:#5c6672;font-style:italic}}
h2{{font-size:16px;margin:34px 0 8px;padding-top:18px;border-top:1px solid var(--bd)}}
h2 .tag{{font-size:12px;font-weight:400;margin-left:8px}}
.note{{background:var(--panel);border:1px solid var(--bd);border-left:3px solid var(--warn);
border-radius:8px;padding:13px 17px;margin:14px 0 0;color:#c9d1d9;font-size:12.5px}}
.note b{{color:var(--warn)}}
.hide{{display:none!important}}
footer{{color:var(--mut);font-size:11.5px;padding:20px 32px 40px;border-top:1px solid var(--bd);margin-top:30px}}
</style></head><body>
<header>
  <h1>仓库 #{data.get('repoId')} 接口清单</h1>
  <div class="sub">
    数据源：<code>{escape(source)}</code><br>
    由<b>结构化查询</b>直接从 <code>url_patterns</code> 取全量 —— 条数即全集，不是检索 top-K。<br>
    生成时间 {escape(generated_at)}
  </div>
</header>

<div class="cards">
  <div class="card"><div class="k">原始行数</div><div class="v">{data.get('total')}</div>
    <div class="n">url_patterns 未去重</div></div>
  <div class="card"><div class="k">去重后</div><div class="v">{len(rows)}</div>
    <div class="n">same method + realPath 合并</div></div>
  <div class="card"><div class="k">真实接口</div><div class="v" style="color:var(--ok)">{len(real_rows)}</div>
    <div class="n">method 已判定</div></div>
  <div class="card"><div class="k">method 未判定</div><div class="v" style="color:var(--warn)">{len(unknown_rows)}</div>
    <div class="n">诊断区，见文末</div></div>
</div>

<div class="main">
  <div class="chips">{chips}</div>

  <div class="bar">
    <button class="mf on" data-f="">全部 <span id="c0">{len(real_rows)}</span></button>
    {"".join(f'<button class="mf" data-f="{escape(m)}">{escape(m)} {by_method.get(m, 0)}</button>' for m in color_order if m != "(未判定)")}
    <input id="q" placeholder="过滤：路径 / 原始写法 / 文件…">
    <span id="count"></span>
  </div>

  {"".join(sections)}

  <h2>未判定 method 的行 <span class="tag" style="color:var(--warn)">{len(unknown_rows)} 条</span></h2>
  <div class="note">
    <b>为什么要单独列：</b>索引器没能从调用点推断出 HTTP method。这里<b>混着两种东西</b> ——
    真接口（只是方法未判定）与根本不是接口的路径（前端路由 / 构建产物 / UI 文案 / 外部 CDN）。
    直接把它们当接口报数会虚高；直接删掉又会漏掉真接口。判定规则见
    <code>scripts/render-interface-inventory.py:triage()</code>，可复核。
  </div>

  <h3 style="margin-top:20px">① 真接口（method 未判定）· {len(tri['真接口'])} 条</h3>
  <table><thead><tr><th>真实路径</th><th>原始写法</th><th>定义位置</th><th>判定依据</th></tr></thead>
  <tbody>{real_unknown}</tbody></table>

  <h3 style="margin-top:26px">② 非接口 · {len(tri['非接口'])} 条</h3>
  <table><thead><tr><th>路径</th><th>原始写法</th><th>定义位置</th><th>为什么不是接口</th></tr></thead>
  <tbody>{fake_unknown}</tbody></table>
</div>

<footer>
  由 <code>scripts/render-interface-inventory.py</code> 生成 · 数据来自线上结构化路由
  <code>GET /repos/{data.get('repoId')}/url-patterns</code>，可随时重跑去核对（脚本本身不写库、只读）。
</footer>

<script>
var rows = [].slice.call(document.querySelectorAll('section.grp tbody tr'));
var secs = [].slice.call(document.querySelectorAll('section.grp'));
var cur = '', q = '';
var qEl = document.getElementById('q');
function apply(){{
  var n = 0;
  rows.forEach(function(tr){{
    var okM = !cur || tr.getAttribute('data-method') === cur;
    var okQ = !q || tr.getAttribute('data-key').indexOf(q) >= 0;
    var show = okM && okQ;
    tr.classList.toggle('hide', !show);
    if (show) n++;
  }});
  secs.forEach(function(s){{
    var any = s.querySelectorAll('tbody tr:not(.hide)').length;
    s.classList.toggle('hide', any === 0);
  }});
  document.getElementById('count').textContent = '显示 ' + n + ' / ' + rows.length;
}}
document.querySelectorAll('button.mf').forEach(function(b){{
  b.onclick = function(){{
    document.querySelectorAll('button.mf').forEach(function(x){{ x.classList.remove('on'); }});
    b.classList.add('on');
    cur = b.getAttribute('data-f');
    apply();
  }};
}});
qEl.oninput = function(){{ q = qEl.value.trim().toLowerCase(); apply(); }};
apply();
</script>
</body></html>
"""


def main():
    data, source = load()
    rows = sorted(data["rows"], key=method_sort_key)
    os.makedirs(OUT_DIR, exist_ok=True)
    ts = datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%d %H:%M:%S %z")

    stem = os.path.join(OUT_DIR, f"repo{data.get('repoId')}-interfaces-live")
    write_csv(stem + ".csv", rows)
    with open(stem + ".html", "w", encoding="utf-8") as fh:
        fh.write(render_html(data, rows, source, ts))

    real = sum(1 for r in rows if r["method"] is not None)
    unk = len(rows) - real
    tri = {"真接口": 0, "非接口": 0}
    for r in rows:
        if r["method"] is None:
            tri[triage(r)[0]] += 1

    print(f"source       : {source}")
    print(f"原始行数     : {data.get('total')}")
    print(f"去重后       : {len(rows)}")
    print(f"真实接口     : {real}   (byMethod: {data.get('byMethod')})")
    print(f"未判定       : {unk}  → 真接口 {tri['真接口']} / 非接口 {tri['非接口']}")
    print(f"写出         : {stem}.html")
    print(f"             : {stem}.csv")


if __name__ == "__main__":
    main()
