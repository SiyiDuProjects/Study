import { useState } from "react";
import { Alert, Button, Modal, Popover, Slider, Switch } from "@heroui/react";
import { ItemCard } from "@heroui-pro/react/item-card";
import { ItemCardGroup } from "@heroui-pro/react/item-card-group";
import { Settings, X } from "lucide-react";
import type { AppSettings } from "../types";

export function SubtitleSettings({ settings, onChange, isOpen, onOpenChange }: {
  settings: AppSettings; onChange: (settings: AppSettings) => Promise<void>;
  isOpen: boolean; onOpenChange: (open: boolean) => void;
}) {
  return <Popover isOpen={isOpen} onOpenChange={onOpenChange}>
    <Button variant="ghost" aria-label="设置"><Settings size={18} /><span className="top-button-label">设置</span></Button>
    <Popover.Content placement="bottom end" offset={12} className="subtitle-settings-popover"><Popover.Dialog>
      <div className="settings-heading"><Popover.Heading>字幕设置</Popover.Heading><Button isIconOnly variant="ghost" aria-label="关闭设置" onPress={() => onOpenChange(false)}><X size={17} /></Button></div>
      <ItemCardGroup variant="transparent">
        <ItemCard variant="transparent" className="font-size-setting"><ItemCard.Content><ItemCard.Title>字幕字号</ItemCard.Title><Slider aria-label="字幕字号" minValue={0.8} maxValue={1.5} step={0.05} value={settings.subtitleScale} onChange={value => void onChange({ ...settings, subtitleScale: value as number })}><Slider.Output /> <Slider.Track><Slider.Fill /><Slider.Thumb /></Slider.Track></Slider></ItemCard.Content></ItemCard>
        <ItemCard variant="transparent"><ItemCard.Content><ItemCard.Title>韩文原文</ItemCard.Title><ItemCard.Description>显示在中文字幕下方</ItemCard.Description></ItemCard.Content><ItemCard.Action><Switch aria-label="显示韩文原文" isSelected={settings.showKoreanInline} onChange={isSelected => void onChange({ ...settings, showKoreanInline: isSelected })}><Switch.Content><Switch.Control><Switch.Thumb /></Switch.Control></Switch.Content></Switch></ItemCard.Action></ItemCard>
      </ItemCardGroup><p className="settings-hint">立即应用 · 自动保存到当前浏览器</p>
    </Popover.Dialog></Popover.Content>
  </Popover>;
}

export function Notice({ message, warning = false }: { message: string; warning?: boolean }) {
  return <Alert status={warning ? "warning" : "danger"} className="workspace-notice"><Alert.Indicator /><Alert.Content><Alert.Description>{message}</Alert.Description></Alert.Content></Alert>;
}

export function useConfirmation() {
  const [pending, setPending] = useState<{ message: string; resolve: (answer: boolean) => void } | null>(null);
  function finish(answer: boolean) { pending?.resolve(answer); setPending(null); }
  function confirm(message: string) { return new Promise<boolean>(resolve => setPending({ message, resolve })); }
  const dialog = <Modal.Backdrop isOpen={Boolean(pending)} onOpenChange={open => { if (!open) finish(false); }}><Modal.Container size="sm"><Modal.Dialog><Modal.CloseTrigger aria-label="关闭确认" /><Modal.Header><Modal.Heading>请确认这项操作</Modal.Heading></Modal.Header><Modal.Body><p className="confirmation-message">{pending?.message}</p></Modal.Body><Modal.Footer><Button variant="outline" onPress={() => finish(false)}>取消</Button><Button onPress={() => finish(true)}>确认</Button></Modal.Footer></Modal.Dialog></Modal.Container></Modal.Backdrop>;
  return { confirm, dialog };
}
