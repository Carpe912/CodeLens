const capabilities = [
  '路由 / 页面 / 组件 / template 文案',
  'API 调用 / 请求拦截器 / 响应处理',
  'import / export / 函数调用链',
  'token / session / cookie / localStorage 逻辑',
];

const scenarios = [
  {
    title: '功能定位',
    description: '回答“功能在哪里”，返回文件、函数、行号和调用链。',
  },
  {
    title: '方案问答',
    description: '回答“登录方案是什么”“这个页面的数据流怎么走”。',
  },
  {
    title: '根因分析',
    description: '围绕 token、路由守卫、请求链路和状态流解释 bug 原因。',
  },
  {
    title: '证据回溯',
    description: '输出代码片段、命中依据和相关调用链，便于人工复核。',
  },
];

const pipeline = [
  {
    step: '1. 接入',
    detail: 'GitLab 地址同步或 ZIP 包上传，形成仓库快照。',
  },
  {
    step: '2. 解析',
    detail: 'AST 切块、符号抽取、路由/API/状态流识别。',
  },
  {
    step: '3. 索引',
    detail: '全文检索 + 向量检索 + 调用链图谱联合召回。',
  },
  {
    step: '4. 推理',
    detail: 'LLM 汇总证据，生成可追溯的定位、问答与根因结论。',
  },
];

function App() {
  return (
    <main className="page">
      <section className="hero">
        <div className="hero-copy">
          <span className="badge">Private Code Intelligence</span>
          <h1>CodeLens</h1>
          <p className="lead">面向私有代码仓库的代码智能问答与根因分析平台。</p>
          <p className="description">
            通过 GitLab 接入或 ZIP 上传建立代码知识库，结合全文检索、语义检索、调用链分析与 LLM
            推理，精准回答“功能在哪里”“方案是什么”“为什么出 bug”。
          </p>
          <div className="actions">
            <button>接入 GitLab</button>
            <button className="secondary">上传代码包</button>
          </div>
        </div>

        <div className="hero-panel">
          <div className="panel-card">
            <h2>系统分层</h2>
            <ul>
              <li>Web 管理台：接入、索引、问答与证据展示</li>
              <li>API 服务：仓库管理、搜索、问答、根因分析</li>
              <li>Worker / Indexer：拉取、解析、切块、建索引</li>
              <li>LLM 编排层：分类、汇总、推理、解释</li>
            </ul>
          </div>
          <div className="panel-card accent">
            <h2>返回结果</h2>
            <p>文件路径、函数名、精确行号、调用链和证据片段。</p>
          </div>
        </div>
      </section>

      <section className="section-title">
        <h2>为什么它不是全文搜索</h2>
        <p>核心判断是“代码知识库 + 语义检索 + 调用链分析 + LLM 推理”。</p>
      </section>

      <section className="grid two-cols">
        <article className="card">
          <h3>关键能力</h3>
          <ul>
            {capabilities.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </article>
        <article className="card">
          <h3>MVP 范围</h3>
          <ul>
            <li>GitLab 接入与 ZIP 上传</li>
            <li>仓库索引与增量更新</li>
            <li>关键词搜索与语义搜索</li>
            <li>行号定位、功能问答与根因分析</li>
          </ul>
        </article>
      </section>

      <section className="section-title">
        <h2>处理链路</h2>
        <p>从代码接入到答案生成，确保每个结论都能回溯到证据。</p>
      </section>

      <section className="grid four-cols">
        {pipeline.map((item) => (
          <article key={item.step} className="card pipeline-card">
            <h3>{item.step}</h3>
            <p>{item.detail}</p>
          </article>
        ))}
      </section>

      <section className="section-title">
        <h2>典型问题</h2>
        <p>既能找功能，也能解释方案，还能定位根因。</p>
      </section>

      <section className="grid">
        {scenarios.map((item) => (
          <article key={item.title} className="card">
            <h3>{item.title}</h3>
            <p>{item.description}</p>
          </article>
        ))}
      </section>
    </main>
  );
}

export default App;
