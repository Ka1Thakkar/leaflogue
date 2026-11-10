import type { SVGProps } from "react";
import { Icon, type IconName } from "./icons";

/**
 * The app's icons, all from Leaflogue's one hand-drawn set in @leaflogue/ui,
 * under the names the screens use. Sizes snap to three steps and every icon
 * shares one stroke weight, so icons match wherever they appear.
 */
export type IconProps = { readonly size?: number; readonly strokeWidth?: number } & Omit<SVGProps<SVGSVGElement>, "name">;
export type AppIcon = (props: IconProps) => React.ReactNode;

function snap(size = 17): number {
  return size <= 14 ? 14 : size <= 16 ? 15 : 17;
}

function make(name: IconName): AppIcon {
  // A caller's stroke width is deliberately ignored: one weight for every icon.
  const Drawn: AppIcon = (props) => {
    const { size, ...rest } = props;
    delete (rest as { strokeWidth?: number }).strokeWidth;
    return <Icon name={name} size={snap(size)} {...rest} />;
  };
  return Drawn;
}

export const X = make("close");
export const Pencil = make("edit");
export const Trash2 = make("trash");
export const StickyNote = make("note-paper");
export const Search = make("search");
export const Plus = make("plus");
export const Network = make("threads");
export const Check = make("check");
export const CheckCheck = make("check-all");
export const Tags = make("tag");
export const Sparkles = make("explain");
export const RefreshCw = make("sync");
export const MoreHorizontal = make("more");
export const Leaf = make("leaf");
export const History = make("history");
export const FolderOpen = make("folder-open");
export const Folder = make("folder");
export const Download = make("import");
export const Upload = make("upload");
export const CalendarDays = make("calendar");
export const ArrowLeft = make("arrow-left");
export const ArrowRight = make("arrow-right");
export const ArrowDownWideNarrow = make("sort");
export const Archive = make("archive");
export const ArchiveRestore = make("restore");
export const Usb = make("reader");
export const Sun = make("sun");
export const SlidersHorizontal = make("sliders");
export const Save = make("save");
export const Rows3 = make("rows");
export const RotateCcw = make("reset");
export const Palette = make("palette");
export const Library = make("library");
export const HardDrive = make("disk");
export const GitMerge = make("merge");
export const Database = make("database");
export const Cloud = make("cloud");
export const CircleAlert = make("alert");
export const ChevronUp = make("chevron-up");
export const ChevronDown = make("chevron-down");
export const ChevronLeft = make("back");
export const ChevronRight = make("chevron-right");
export const BookOpen = make("book");
export const Bell = make("bell");
export const Filter = make("funnel");
export const UserRound = make("profile");
export const LogOut = make("sign-out");
