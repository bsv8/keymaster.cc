// JSON 预览的树化：把解析结果变成按需展开、有界的节点结构。
//
// 页面不会对一个巨大 JSON 直接 stringify 后塞进 DOM。这里把每个对象/数组的成员
// 变成一个可折叠节点，并且**只为前若干层预生成子节点**；更深、更宽的成员在用户
// 点击展开时才生成。
//
// 为什么「按需」必须是真按需：递归深度与文档深度同阶，而 JavaScript 的调用栈有
// 上限。一份 20 KB、10,000 层的 JSON 完全在 1 MiB 预览上限之内，`JSON.parse` 也能
// 正常返回，但它会让任何「先递归到底再按深度丢弃」的写法直接 RangeError，用户看到
// 的是空白预览。因此这里的硬性规则是：预生成只走 expandDepth 层，展开时一次只多
// 一层，且每层宽度有上限。

/** 单个可见节点。 */
export interface BrowseJsonNode {
  /** 稳定的节点 key；同值不同位置不会互相干扰。 */
  key: string;
  /** 展示名：根是空串，数组用下标，对象用原始键。 */
  label: string;
  /** 对象成员数或数组长度。 */
  size?: number;
  /** 是否是可展开的容器。 */
  expandable: boolean;
  /** 标量的原始文本；容器省略。 */
  scalar?: string;
  /** 已生成的直接子节点；未生成时省略。 */
  children?: BrowseJsonNode[];
  /**
   * 容器原值。
   *
   * 按需生成子节点时唯一的输入；只保留引用，不复制结构，因此预生成层数不影响
   * 内存占用。
   */
  value?: unknown;
  /** 子节点因深度上限未预生成，需要用户点击展开。 */
  deferredByDepth?: boolean;
}

/** 默认自动展开层数；再深的节点需要用户点击。 */
export const JSON_DEFAULT_EXPAND_DEPTH = 2;
/** 单个容器一次生成的子节点数上限；其余通过「更多成员」逐段生成。 */
export const JSON_MAX_CHILDREN = 200;

/** 单个标量文本的长度上限：超长字符串不整段塞进 DOM。 */
const SCALAR_MAX_CHARS = 2_000;

function truncateScalar(text: string): string {
  return text.length <= SCALAR_MAX_CHARS ? text : text.slice(0, SCALAR_MAX_CHARS) + "…";
}

/**
 * 标量文本。
 *
 * 字符串按 JSON 字符串展示（含引号），让用户能看出转义与首尾空格；数字和
 * 布尔用字面量；null 与 undefined 单独标记。
 */
export function describeJsonScalar(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  switch (typeof value) {
    case "string":
      return truncateScalar(JSON.stringify(value));
    case "number":
    case "boolean":
      return String(value);
    case "bigint":
      return value + "n";
    default:
      return truncateScalar(String(value));
  }
}

/** JSON 值的类型标签，用于节点左侧的彩色标记。 */
export function jsonTypeLabel(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "object":
      return "object";
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "undefined":
      return "undefined";
    default:
      return typeof value;
  }
}

function isContainer(value: unknown): value is object {
  return value !== null && typeof value === "object";
}

/** 容器的成员键：数组用下标，对象用原始键。 */
function childKeys(value: object): string[] {
  return Array.isArray(value)
    ? value.map((_item, index) => String(index))
    : Object.keys(value);
}

function childValue(value: object, key: string): unknown {
  return Array.isArray(value)
    ? (value as unknown[])[Number(key)]
    : (value as Record<string, unknown>)[key];
}

/** 只构造节点本身，不向下递归。 */
function makeNode(value: unknown, key: string, label: string): BrowseJsonNode {
  if (!isContainer(value)) return { key, label, expandable: false, scalar: describeJsonScalar(value) };
  const size = childKeys(value).length;
  return {
    key,
    label,
    expandable: size > 0,
    ...(size > 0 ? { size } : {}),
    value,
    // 深度预算之外的容器没有 children，需要用户点开。
    deferredByDepth: true,
  };
}

/**
 * 生成某个容器当前窗口内的直接子节点。
 *
 * 每个子节点都只构造自身（`makeNode`），因此这里的调用深度恒为 1：展开一个 10,000
 * 层的 JSON 只会一次多出一层，不会把栈吃光。宽度由 `windowSize` 限制，剩下的成员
 * 由 {@link jsonHiddenChildren} 告知 UI，用户点「更多成员」时可以带着更大的窗口
 * 再调一次。
 */
export function jsonChildrenOf(node: BrowseJsonNode, windowSize: number = JSON_MAX_CHILDREN): BrowseJsonNode[] {
  if (!isContainer(node.value)) return [];
  const keys = childKeys(node.value);
  const count = Math.min(keys.length, Math.max(0, windowSize));
  const children: BrowseJsonNode[] = [];
  for (let index = 0; index < count; index += 1) {
    const childKey = keys[index]!;
    children.push(makeNode(childValue(node.value, childKey), node.key + "/" + childKey, childKey));
  }
  return children;
}

/**
 * 窗口之外还有多少成员。
 *
 * `generated` 是当前实际生成的子节点数：懒生成下节点上不保存 children，所以计数只能
 * 由调用方给出，否则「还有多少没显示」永远算不准。
 */
export function jsonHiddenChildren(node: BrowseJsonNode, generated: number): number {
  if (!node.expandable || node.size === undefined) return 0;
  return Math.max(0, node.size - generated);
}

/**
 * 把解析后的 JSON 变成树。
 *
 * 只为前 `expandDepth` 层预生成子节点；再深的容器仍然是可展开节点，点击时才生成
 * 下一层。宽度同样有窗口上限，因此「预生成的节点总数」与文档大小无关。
 *
 * @param value 已解析的值。
 * @param expandDepth 自动展开到第几层；更深的容器仍然可点击展开。
 */
export function buildJsonTree(value: unknown, expandDepth: number = JSON_DEFAULT_EXPAND_DEPTH): BrowseJsonNode {
  const root = makeNode(value, "", "");
  if (!root.expandable) return root;
  const expand = Math.max(0, expandDepth);
  let current: BrowseJsonNode[] = [root];
  for (let depth = 0; depth < expand; depth += 1) {
    const next: BrowseJsonNode[] = [];
    for (const node of current) {
      if (!node.expandable || node.value === undefined) continue;
      const children = jsonChildrenOf(node);
      node.children = children;
      node.deferredByDepth = false;
      next.push(...children);
    }
    if (next.length === 0) break;
    current = next;
  }
  return root;
}

/** 树里已生成的节点总数；用于确认有界渲染确实限制了规模。 */
export function jsonNodeCount(root: BrowseJsonNode): number {
  if (!root.children) return 1;
  return 1 + root.children.reduce((total, child) => total + jsonNodeCount(child), 0);
}
