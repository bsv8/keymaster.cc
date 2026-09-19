// packages/runtime/src/react/useBsvPrice.ts
// 读取 Keymaster 当前 BSV 展示价（金额 + 单位）的 React hook。
//
// 设计缘由：
//   - 首页 / 资产页 / P2PKH 钱包页只需要展示价，不关心频道与交易对；
//   - 价格能力是可选能力：插件未启用或 owner 会话切换时返回 null；
//   - `get()` 每次都返回新对象，直接放进 useSyncExternalStore 会导致
//     无限重渲染；这里用 ref 缓存同一订阅周期内的值，只有推送或
//     能力实例变化时才更新。

import { useCallback, useRef, useSyncExternalStore } from "react";
import { useOptionalCapability } from "webloom-framework/react";
import {
  BSV_PRICE_READER_CAPABILITY,
  type BsvPriceReader,
  type PriceValue
} from "@keymaster/contracts";

/** 当前展示价格；价格能力不可用时为 null（调用方按 0 展示）。 */
export function useBsvPrice(): PriceValue | null {
  const reader = useOptionalCapability(BSV_PRICE_READER_CAPABILITY);
  const cache = useRef<{ reader: BsvPriceReader; value: PriceValue } | null>(null);

  const getSnapshot = useCallback((): PriceValue | null => {
    if (!reader) {
      cache.current = null;
      return null;
    }
    if (!cache.current || cache.current.reader !== reader) {
      cache.current = { reader, value: reader.get() };
    }
    return cache.current.value;
  }, [reader]);

  const subscribe = useCallback((onChange: () => void) => {
    if (!reader) return () => undefined;
    return reader.subscribe((price) => {
      cache.current = { reader, value: price };
      onChange();
    });
  }, [reader]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
