"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createTrip, todayStr } from "@/lib/store";
import { X } from "@phosphor-icons/react";

export function CreateTripModal({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [startDate, setStartDate] = useState(todayStr());
  const [endDate, setEndDate] = useState(addDaysStr(todayStr(), 2));
  const [notes, setNotes] = useState("");

  const canSave = name.trim().length > 0 && startDate && endDate && startDate <= endDate;

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Escape 关闭（对话框标准交互）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function handleCreate() {
    if (!canSave || saving) return;
    setSaving(true);
    setError("");
    try {
    const trip = await createTrip({
      name: name.trim(),
      startDate,
      endDate,
      description: notes.trim() || undefined,
    });
    onClose();
    router.push(`/trip/${trip.id}`);
    } catch (e) { setError(e instanceof Error ? e.message : "创建失败"); }
    finally { setSaving(false); }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-card fade-up"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-trip-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <span className="font-mono kicker">NEW TRIP</span>
          <button className="modal-close" onClick={onClose} aria-label="关闭">
            <X size={17} weight="bold" aria-hidden="true" />
          </button>
        </div>

        <h2 className="font-display modal-title" id="create-trip-title">开启一段新的旅程</h2>

        <label className="field">
          <span>旅行名称</span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：上海四日游"
            onKeyDown={(e) => e.key === "Enter" && canSave && handleCreate()}
          />
        </label>

        <div className="field-row">
          <label className="field">
            <span>开始日期</span>
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </label>
          <label className="field">
            <span>结束日期</span>
            <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          </label>
        </div>

        <label className="field">
          <span>出行备注</span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="随便记点什么：想去的地方、要带的东西、同行的人……"
            rows={4}
          />
        </label>

        {error && <p role="alert" className="modal-error">{error}</p>}
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button className="btn" disabled={!canSave || saving} onClick={handleCreate}>
            创建行程
          </button>
        </div>
      </div>
    </div>
  );
}

function addDaysStr(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
