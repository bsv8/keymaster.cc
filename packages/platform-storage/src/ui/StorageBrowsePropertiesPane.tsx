// 浏览页的「属性」面板。
//
// 这里只呈现 Worker 返回的元数据与页面已知的目录标记对象路径。完整路径、完整
// 哈希、完整公钥都必须原样出现：树里为了排版做的缩写只属于树。
import type { StorageBrowsePreview } from "../runtime/storageBrowseTypes.js";
import type { BrowseChildNode, BrowseDirectoryMarker } from "./storageBrowseTree.js";
import { formatBytes, formatTimestamp } from "./storageBrowseText.js";
import type { BrowseTranslate } from "./StorageBrowsePreviewPane.js";

export interface PropertiesPaneProps {
  locale: string;
  translate: BrowseTranslate;
  /** 当前选中的文件或目录节点；没有选择时面板显示引导文案。 */
  selected: BrowseChildNode | undefined;
  /** 该文件的预览结果；属性即使预览失败也继续可用。 */
  preview: StorageBrowsePreview | undefined;
  /** 当前目录自己的 .dir 标记元数据。 */
  directoryMarker: BrowseDirectoryMarker | undefined;
  /** 复制完整路径。 */
  onCopyPath: () => void;
}

export function PropertiesPane(props: PropertiesPaneProps) {
  const { translate: t, selected } = props;
  if (!selected) {
    return (
      <p className="storage-browse__hint">
        {t("storage.browse.properties.noSelection", { defaultValue: "Select a file to see its properties." })}
      </p>
    );
  }
  return (
    <div className="storage-browse__properties">
      <div className="storage-browse__path-row">
        <code className="storage-browse__path">{selected.path}</code>
        <button type="button" className="storage-browse__copy" onClick={props.onCopyPath}>
          {t("storage.browse.copyPath", { defaultValue: "Copy path" })}
        </button>
      </div>
      {selected.kind === "directory" ? (
        <p className="storage-browse__hint">
          {t("storage.browse.properties.directoryHint", {
            defaultValue: "A directory is stored as a folder of objects; its own metadata is the marker below.",
          })}
        </p>
      ) : null}
      <dl className="storage-browse__props">
        <dt>{t("storage.browse.props.size", { defaultValue: "Size" })}</dt>
        <dd>
          {selected.size === undefined
            ? "—"
            : formatBytes(selected.size) + " (" + String(selected.size) + " B)"}
        </dd>
        <dt>{t("storage.browse.props.modified", { defaultValue: "Modified" })}</dt>
        <dd>
          {selected.lastModified === undefined
            ? "—"
            : formatTimestamp(selected.lastModified, props.locale)}
        </dd>
        <dt>{t("storage.browse.props.revision", { defaultValue: "Revision" })}</dt>
        <dd><code>{selected.revision ?? "—"}</code></dd>
        <dt>{t("storage.browse.props.contentType", { defaultValue: "Content type" })}</dt>
        <dd>
          <code>{props.preview?.contentType ?? selected.contentType ?? "—"}</code>
        </dd>
        <dt>{t("storage.browse.props.format", { defaultValue: "Preview format" })}</dt>
        <dd>{props.preview ? props.preview.format : "—"}</dd>
      </dl>
      {props.directoryMarker ? (
        <section className="storage-browse__marker">
          <h3 className="storage-browse__marker-title">
            {t("storage.browse.marker.title", { defaultValue: "Directory marker" })}
          </h3>
          <dl className="storage-browse__props">
            <dt>{t("storage.browse.props.path", { defaultValue: "Path" })}</dt>
            <dd><code>{props.directoryMarker.path}</code></dd>
            <dt>{t("storage.browse.props.size", { defaultValue: "Size" })}</dt>
            <dd>{formatBytes(props.directoryMarker.size)}</dd>
            <dt>{t("storage.browse.props.modified", { defaultValue: "Modified" })}</dt>
            <dd>{formatTimestamp(props.directoryMarker.lastModified, props.locale)}</dd>
            <dt>{t("storage.browse.props.revision", { defaultValue: "Revision" })}</dt>
            <dd><code>{props.directoryMarker.revision}</code></dd>
          </dl>
          <p className="storage-browse__hint">
            {t("storage.browse.marker.hint", {
              defaultValue:
                "This zero-byte marker object is how an empty directory is stored; it is not a separate file.",
            })}
          </p>
        </section>
      ) : null}
    </div>
  );
}
