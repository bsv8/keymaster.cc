import { EmptyState } from "@keymaster/ui";
import { useI18n, usePluginHost, useRegistry, useRuntimeStatus } from "@keymaster/runtime";

export function groupBusinessProjections<T extends { space: { id: string; order: number } }>(projections: readonly T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const projection of projections) {
    let group = groups.get(projection.space.id);
    if (!group) { group = []; groups.set(projection.space.id, group); }
    group.push(projection);
  }
  return [...groups.values()].sort((a, b) => a[0]!.space.order - b[0]!.space.order || a[0]!.space.id.localeCompare(b[0]!.space.id));
}

export function BusinessHomePage() {
  const { t } = useI18n();
  const host = usePluginHost();
  const { vault } = useRuntimeStatus();
  const projections = useRegistry((host) => host.business.listHomeProjections()).filter((projection) => projection.visibleWhen ? projection.visibleWhen({ unlocked: vault === "unlocked" }) : true);
  const spaces = groupBusinessProjections(projections);
  if (projections.length === 0) {
    return <EmptyState title={t("home.business.empty.title", { defaultValue: "暂无业务内容" })} description={t("home.business.empty.description", { defaultValue: "迁移业务功能后会显示在这里。" })} />;
  }
  return <>{spaces.map((spaceProjections) => <section key={spaceProjections[0]?.space.id} className="business-home__space"><h2>{host.i18n.text(spaceProjections[0]!.space.label)}</h2>{spaceProjections.map((projection) => <div key={projection.id} className="home-layout__cell"><projection.component /></div>)}</section>)}</>;
}
