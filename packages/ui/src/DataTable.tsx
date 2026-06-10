// packages/ui/src/DataTable.tsx
// 通用表格组件：列由调用方声明，每行数据由父组件传入。
// 设计缘由：插件只关心业务字段，表格样式/分页都交给 UI 库处理。

import type { ReactNode } from "react";

export interface DataTableColumn<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  width?: string;
}

export interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  rows: T[];
  empty?: ReactNode;
  rowKey: (row: T) => string;
}

export function DataTable<T>({ columns, rows, empty, rowKey }: DataTableProps<T>) {
  if (rows.length === 0) {
    return <div className="ui-data-table__empty">{empty ?? "No data"}</div>;
  }
  return (
    <div className="ui-data-table">
      <table>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} style={c.width ? { width: c.width } : undefined}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((c) => (
                <td key={c.key}>{c.render(row)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
