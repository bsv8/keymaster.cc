import { Star } from "lucide-react";
import { Button } from "@keymaster/ui";

/** 空心星表示可收藏，实心星表示已收藏；操作名称供悬停和辅助技术使用。 */
export function FavoriteButton({ favorite, label = favorite ? "取消收藏" : "收藏", disabled, onClick, testId }: { favorite: boolean; label?: string; disabled?: boolean; onClick(): void; testId: string }) {
  return <Button variant="ghost" className="apps-favorite-toggle" title={label} aria-label={label} aria-pressed={favorite} disabled={disabled} data-testid={testId} onClick={onClick}>
    <Star size={22} fill={favorite ? "currentColor" : "none"} aria-hidden="true" />
  </Button>;
}
