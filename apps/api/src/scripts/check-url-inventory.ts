/**
 * URL 展开的作用域规则自检（纯逻辑，不连数据库）
 *
 * 为什么值得单独测：这套规则的每一条都对应一个**已经踩过的坑**，
 * 而且踩错的后果是「看起来很像真的」的假路径 —— 比展不开危险得多。
 *
 * 覆盖的规则：
 *   1. 文件内定义只在文件内可见（`scope` 在 14 个文件里各定义一次）
 *   2. 非 export 的定义不能跨文件使用
 *   3. `const PTRFIX = ""` 这类**空串**定义必须能被解析（曾经被 `template &&` 吃掉）
 *   4. 同名被多个文件 export -> 有歧义 -> 宁可展不开
 *   5. `${url}` 这类运行时变量一律不解析（曾经被函数内的 `const url` 误解析）
 *   6. 递归展开时作用域应切到「定义所在文件」
 *   7. 字面量 pattern 直接归一化
 *
 * 后半段另外测 `classifyUndecidedRow`（method 未判定的行到底是不是接口）——
 * 它决定了「接口数」报出去的到底是 238 还是 277，属于同一条链路上的事。
 *
 * 用法：npm run check:url-inventory
 */

import {
  expandUrlPattern,
  classifyUndecidedRow,
  type HelperIndex,
  type HelperDef,
  type UndecidedKind,
} from '../analysis/url-inventory.js';

interface Case {
  name: string;
  pattern: string;
  defFile: string | null;
  expect: string | null;
}

function makeIndex(): HelperIndex {
  const def = (template: string, file: string, exported = false): HelperDef => ({ template, file, exported });
  return {
    local: new Map([
      [
        'src/service/Api/base.ts',
        new Map([
          ['PTRFIX', def('', 'src/service/Api/base.ts')],
          ['COOP_URL', def('${PTRFIX}/rest', 'src/service/Api/base.ts', true)],
          ['QUALITY_URL', def('${COOP_URL}/quality/a/${appId}', 'src/service/Api/base.ts', true)],
          ['TEST_URL_API', def('/plugin/api', 'src/service/Api/base.ts', true)],
        ]),
      ],
      [
        'src/service/Api/TestScenario/index.ts',
        new Map([['scope', def('${COOP_URL}/quality/a/${appId}', 'src/service/Api/TestScenario/index.ts')]]),
      ],
      [
        'src/service/Api/TestScenarioReport/index.ts',
        new Map([['scope', def('${COOP_URL}/quality/a/${appId}/api/report', 'src/service/Api/TestScenarioReport/index.ts')]]),
      ],
      [
        'src/service/Api/TestScenarioExecute/index.ts',
        new Map([['scope', def('${TEST_URL_API}/log', 'src/service/Api/TestScenarioExecute/index.ts')]]),
      ],
      [
        'src/service/Api/ApiCase/index.ts',
        new Map([
          ['CASE_URL', def('${QUALITY_URL(appId)}/api/case', 'src/service/Api/ApiCase/index.ts')],
        ]),
      ],
    ]),
    global: new Map([
      ['COOP_URL', def('${PTRFIX}/rest', 'src/service/Api/base.ts', true)],
      ['QUALITY_URL', def('${COOP_URL}/quality/a/${appId}', 'src/service/Api/base.ts', true)],
      ['TEST_URL_API', def('/plugin/api', 'src/service/Api/base.ts', true)],
    ]),
    ambiguous: [],
    filesScanned: 5,
  };
}

const cases: Case[] = [
  // 1 + 6：同一名字 `scope`，按定义文件解析到不同前缀
  {
    name: '文件内 scope -> /rest/quality/a/{appId}',
    pattern: '${scope(options.appId)}/api/scenario/get',
    defFile: 'src/service/Api/TestScenario/index.ts',
    expect: '/rest/quality/a/:param/api/scenario/get',
  },
  {
    name: '同名 scope 在另一个文件 -> …/api/report',
    pattern: '${scope(options.appId)}/group',
    defFile: 'src/service/Api/TestScenarioReport/index.ts',
    expect: '/rest/quality/a/:param/api/report/group',
  },
  {
    name: '同名 scope 又在另一个文件 -> /plugin/api/log（连基底都换了）',
    pattern: '${scope(appId)}/list',
    defFile: 'src/service/Api/TestScenarioExecute/index.ts',
    expect: '/plugin/api/log/list',
  },
  // 3：空串常量
  {
    name: '空串常量 PTRFIX 必须能展开（否则 /rest 会变成 :param）',
    pattern: '${COOP_URL}/global',
    defFile: 'src/service/Api/base.ts',
    expect: '/rest/global',
  },
  // 6 + 跨文件 export
  {
    name: '跨文件 export 的 QUALITY_URL 可用（且用的是定义处的临时变量）',
    pattern: '${QUALITY_URL(aid)}/api/service/list',
    defFile: 'src/service/Api/TestScenario/index.ts',
    expect: '/rest/quality/a/:param/api/service/list',
  },
  // 2：非 export 的定义不可跨文件
  {
    name: '非 export 的 CASE_URL 在别的文件里不可见',
    pattern: '${CASE_URL(aid)}/delete',
    defFile: 'src/service/Api/TestScenario/index.ts',
    expect: null,
  },
  {
    name: '非 export 的 CASE_URL 在自己文件里可见',
    pattern: '${CASE_URL(aid)}/delete',
    defFile: 'src/service/Api/ApiCase/index.ts',
    expect: '/rest/quality/a/:param/api/case/delete',
  },
  // 5：运行时变量
  {
    name: '${url} 不解析（运行时变量）',
    pattern: '${url}',
    defFile: 'src/service/index.ts',
    expect: null,
  },
  // 7：字面量
  {
    name: '绝对路径字面量原样归一',
    pattern: '/rest/quality/a/${appId.value}/apiDefinition/mock/response',
    defFile: 'x.ts',
    expect: '/rest/quality/a/:param/apiDefinition/mock/response',
  },
  {
    name: '去掉查询串',
    pattern: '/rest/global/file/show/${imgId}?isCached=true',
    defFile: 'x.ts',
    expect: '/rest/global/file/show/:param',
  },
  {
    name: '相对路径补前导斜杠',
    pattern: 'plugin/api/report/search',
    defFile: 'x.ts',
    expect: '/plugin/api/report/search',
  },
  {
    name: '无斜杠的单词不是路径',
    pattern: 'login',
    defFile: 'src/router/routes.ts',
    expect: null,
  },
  {
    name: '无法解析的 helper 如实返回 null（不猜）',
    pattern: '${NO_SUCH_HELPER(a)}/x',
    defFile: 'y.ts',
    expect: null,
  },
];

interface ClassifyCase {
  name: string;
  realPath: string | null;
  pattern: string;
  defFile: string | null;
  expect: UndecidedKind;
}

/**
 * 判定规则的自检。
 *
 * ⚠️ 这里每一条都对应一个**让接口数虚高或虚低**的具体形状：
 * 前端路由被当成接口（虚高）、真实接口被当成非接口（虚低）。
 * 顺序也有意义 —— 例如 vite.config.ts 必须先被「构建产物」接住。
 */
const classifyCases: ClassifyCase[] = [
  // 真接口：method 写在变量里，路径本身是后端接口
  {
    name: 'method 未判定的 /plugin/api/* 判为真接口',
    realPath: '/plugin/api/report/search',
    pattern: 'plugin/api/report/search',
    defFile: 'src/components/AutomatedTesting/TimedTask/MatchScenario/ScenarioTable.vue',
    expect: 'interface',
  },
  {
    name: 'method 未判定的 /rest/* 判为真接口',
    realPath: '/rest/account/customMenu/type/:param/save',
    pattern: '/rest/account/customMenu/type/${type}/save',
    defFile: 'src/components/TestStep/Main.vue',
    expect: 'interface',
  },
  // 非接口：前端路由 / 构建产物 / 文案 / 外部地址
  {
    name: 'Vue/React 路由表里的路径判为非接口',
    realPath: '/login',
    pattern: '/login',
    defFile: 'src/router/routes.ts',
    expect: 'not-interface',
  },
  {
    name: '菜单动态拼接的路径判为非接口',
    realPath: '/task/:id',
    pattern: 'task/:id',
    defFile: 'src/controller/Apiwire/Mounted/initializeRootMenu.ts',
    expect: 'not-interface',
  },
  {
    name: 'vite 构建产物路径判为非接口',
    realPath: '/static/js/main.js',
    pattern: 'static/js/main.js',
    defFile: 'vite.config.ts',
    expect: 'not-interface',
  },
  {
    name: '界面文案（/Read/Write）判为非接口',
    realPath: '/Read/Write',
    pattern: 'Read/Write',
    defFile: 'src/components/JsonSchemaTree/Widget/Setting/Context.ts',
    expect: 'not-interface',
  },
  {
    name: '外部 CDN 地址判为非接口',
    realPath: 'https://cdn.staticfile.org/monaco-editor/0.38.0/min/vs/loader.min.js',
    pattern: 'https://cdn.staticfile.org/monaco-editor/0.38.0/min/vs/loader.min.js',
    defFile: 'src/utils/Source.ts',
    expect: 'not-interface',
  },
  // 优先级：/rest 开头但定义在路由表里 —— 必须被「路由」规则先接住，
  // 否则会变成「真接口」而虚高。
  {
    name: '优先级：/rest 开头但来自前端路由表 -> 非接口（不能被接口规则抢走）',
    realPath: '/rest/something',
    pattern: '/rest/something',
    defFile: 'src/router/routes.ts',
    expect: 'not-interface',
  },
  // 兜底：不认识的不硬塞，如实说「待判」
  {
    name: '未匹配任何特征 -> unknown（不猜）',
    realPath: '/whatever/thing',
    pattern: '/whatever/thing',
    defFile: 'src/some/unknown.ts',
    expect: 'unknown',
  },
];

function main(): void {
  const index = makeIndex();
  let failed = 0;
  for (const c of cases) {
    const actual = expandUrlPattern(c.pattern, c.defFile, index);
    const pass = actual === c.expect;
    if (!pass) failed++;
    console.log(`${pass ? '✅' : '❌'} ${c.name}`);
    if (!pass) {
      console.log(`     pattern : ${c.pattern}`);
      console.log(`     defFile : ${c.defFile}`);
      console.log(`     expect  : ${JSON.stringify(c.expect)}`);
      console.log(`     actual  : ${JSON.stringify(actual)}`);
    }
  }

  console.log('');
  for (const c of classifyCases) {
    const got = classifyUndecidedRow({
      realPath: c.realPath,
      pattern: c.pattern,
      definitionFile: c.defFile,
    });
    const pass = got.kind === c.expect;
    if (!pass) failed++;
    console.log(`${pass ? '✅' : '❌'} ${c.name}`);
    if (!pass) {
      console.log(`     realPath: ${JSON.stringify(c.realPath)}`);
      console.log(`     defFile : ${c.defFile}`);
      console.log(`     expect  : ${c.expect}`);
      console.log(`     actual  : ${got.kind} (${got.reason})`);
    }
  }

  const total = cases.length + classifyCases.length;
  console.log('\n' + '='.repeat(56));
  if (failed === 0) {
    console.log(`✅ ${total} 项全部通过`);
    process.exit(0);
  }
  console.log(`❌ ${failed}/${total} 项失败`);
  process.exit(1);
}

main();
