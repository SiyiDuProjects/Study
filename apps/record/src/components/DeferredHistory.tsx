import { useEffect, useState } from "react";
import { Button } from "@heroui/react";
import { ItemCard } from "@heroui-pro/react/item-card";
import type { RecordHistoryProps } from "./RecordHistory";

type HistoryComponent = typeof import("./RecordHistory")["default"];

// Keep both the recording owner and an already loaded Sheet mounted when views change.
export function DeferredHistory(props: RecordHistoryProps) {
  const [History, setHistory] = useState<HistoryComponent | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!props.isOpen || History) return;
    let active = true;
    setFailed(false);
    void import("./RecordHistory").then(module => {
      if (active) setHistory(() => module.default);
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [props.isOpen, History, attempt]);

  if (History) return <History {...props} />;
  if (!props.isOpen) return null;
  return <ItemCard className="history-loading" role="status"><ItemCard.Content><ItemCard.Title>{failed ? "课堂记录暂时无法打开" : "正在打开课堂记录…"}</ItemCard.Title>{failed ? <ItemCard.Description>请检查网络后重试。字幕仍在继续。</ItemCard.Description> : null}</ItemCard.Content><ItemCard.Action>{failed ? <Button variant="outline" onPress={() => setAttempt(value => value + 1)}>重试</Button> : null}<Button variant="ghost" aria-label="关闭课堂记录" onPress={props.onClose}>关闭</Button></ItemCard.Action></ItemCard>;
}
