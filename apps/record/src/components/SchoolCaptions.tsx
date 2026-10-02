import { useState } from "react";
import { Button, Popover, Switch } from "@heroui/react";
import { ItemCard } from "@heroui-pro/react/item-card";
import type { SchoolCourse } from "../../../core/src/lecture/school-types";
import { setSchoolCourse } from "../lib/api";
import { Notice } from "./SubtitleControls";

export function SchoolCaptions({ courseId, courseName, settings, onChange, usingSchool }: {
  courseId: string; courseName: string; settings: SchoolCourse | undefined;
  onChange: (courses: SchoolCourse[]) => void;
  usingSchool: boolean;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  async function configure(enabled: boolean) {
    setSaving(true); setError("");
    try { onChange(await setSchoolCourse(courseId, enabled)); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "保存同步设置失败。"); }
    finally { setSaving(false); }
  }
  const stale = settings?.enabled && (!settings.lastCheckedAt || Date.now() - Date.parse(settings.lastCheckedAt) > 120_000);
  return <Popover><Button size="sm" variant="ghost" aria-label="字幕来源设置">{usingSchool ? "学校字幕" : "麦克风"}</Button>
    <Popover.Content placement="bottom end" className="subtitle-settings-popover"><Popover.Dialog>
      <Popover.Heading>学校字幕</Popover.Heading>
      <ItemCard variant="transparent"><ItemCard.Content><ItemCard.Title>{courseName}</ItemCard.Title>
        <ItemCard.Description>自动发现每节课的学校转录，保存已有韩文和中文。关闭网页后仍会同步。</ItemCard.Description>
      </ItemCard.Content><ItemCard.Action><Switch aria-label="学校字幕自动同步" isSelected={settings?.enabled ?? false} isDisabled={saving}
        onChange={enabled => void configure(enabled)}><Switch.Content><Switch.Control><Switch.Thumb /></Switch.Control></Switch.Content></Switch></ItemCard.Action></ItemCard>
      {settings?.enabled ? <p className="settings-hint" role="status">{stale ? "等待后台检查" : `已发现 ${settings.sessionCount} 节学校课堂`}
        {settings.lastCheckedAt ? ` · 最近检查 ${new Date(settings.lastCheckedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}` : ""}</p> : null}
      {error || settings?.error ? <Notice message={error || settings!.error!} warning /> : null}
    </Popover.Dialog></Popover.Content>
  </Popover>;
}
