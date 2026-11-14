// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 VCE Hub. Part of the /cas calculator: https://github.com/vcehub/cas
"use client";

import { useEffect, useId, useRef, useState } from "react";

import { BACKEND_URL, postWithAuth } from "@/shared/lib/backend-fetch";
import { cn } from "@/shared/lib/utils";
import { Button } from "@/shared/ui/button";
import { Field } from "@/shared/ui/field";
import { Select } from "@/shared/ui/select";
import { Textarea } from "@/shared/ui/textarea";
import { Input } from "@/shared/ui/input";

import type { Settings } from "./engine/evaluate";
import type { HistoryEntry } from "./state/document";

/** What the calculator hands the form: the page's entries and settings. */
export type ReportSource = {
  page: "calculator" | "graphs";
  entries: HistoryEntry[];
  /** The selected history entry, if any. */
  selected: number | null;
  settings: Settings;
};

export type FeedbackKind = "wrong_answer" | "bug" | "idea";
type Kind = FeedbackKind;

export const KINDS: { id: Kind; label: string; says: string }[] = [
  { id: "wrong_answer", label: "Wrong answer", says: "It gave an answer that isn't right." },
  { id: "bug", label: "Something broken", says: "A key, menu or screen doesn't work." },
  { id: "idea", label: "An idea", says: "Something missing, or that could work better." },
];

/** The entries before the reported one that are sent with it, most recent last. */
const CONTEXT = 30;

const said = (h: HistoryEntry) => h.error ?? h.outputText;
const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
const pair = (e: HistoryEntry) => ({ input: clip(e.inputText, 2000), output: clip(said(e), 4000) });

/**
 * Feedback on the calculator: a wrong answer, something broken, or an idea,
 * to POST /api/cas/reports (backend/routers/cas.py). A wrong answer sends the
 * entry, the answer it gave and the entries before it, which hold the Defines
 * and stored values the answer may depend on; on a Graphs page, or with
 * nothing entered yet, the student types the entry. Something broken sends
 * what they say with the page's last entries, so it can be replayed; an idea
 * is just what they say.
 */
export function ReportForm({
  source,
  onClose,
  initialKind = "wrong_answer",
}: {
  source: ReportSource;
  onClose: () => void;
  /** null asks first, with the three kinds as big choices. */
  initialKind?: Kind | null;
}) {
  const { entries } = source;
  const typed = entries.length === 0;
  const [kind, setKind] = useState<Kind | null>(initialKind);
  const [pick, setPick] = useState(source.selected ?? entries.length - 1);
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const [expected, setExpected] = useState("");
  const [message, setMessage] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "busy" | "failed">("idle");
  const titleId = useId();

  const send = async () => {
    let body: Record<string, unknown>;
    if (kind === "wrong_answer") {
      const h = entries[pick];
      const entry = typed
        ? { input: input.trim(), output: output.trim(), context: [] }
        : h && { input: h.inputText, output: said(h), context: entries.slice(Math.max(0, pick - CONTEXT), pick).map(pair) };
      if (!entry?.input) return;
      body = {
        ...entry,
        input: clip(entry.input, 2000),
        output: clip(entry.output, 4000),
        expected: clip(expected.trim(), 1000),
      };
    } else {
      if (!message.trim()) return;
      body = {
        message: clip(message.trim(), 2000),
        context: kind === "bug" ? entries.slice(-CONTEXT).map(pair) : [],
      };
    }
    setState("sending");
    try {
      const res = await postWithAuth(`${BACKEND_URL}/api/cas/reports`, {
        ...body,
        kind,
        settings: source.settings,
        page: source.page,
      });
      setState(res.ok ? "sent" : res.status === 429 ? "busy" : "failed");
    } catch {
      setState("failed");
    }
  };

  if (kind === null)
    return (
      <div className="space-y-[18px]">
        <h2 className="display-xs m-0">Send feedback</h2>
        <div className="space-y-[8px]">
          {KINDS.map((k) => (
            <button
              key={k.id}
              type="button"
              onClick={() => setKind(k.id)}
              className="block w-full rounded-card border border-hairline px-[16px] py-[12px] text-left transition-colors duration-fast hover:border-borderStrong hover:bg-surface"
            >
              <span className="block text-ui font-semibold text-ink">{k.label}</span>
              <span className="block text-ui text-inkBody">{k.says}</span>
            </button>
          ))}
        </div>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
      </div>
    );

  if (state === "sent")
    return (
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p role="status" className="m-0 text-ui text-inkBody">
          Sent. Thanks.
        </p>
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
      </div>
    );

  return (
    <form
      aria-labelledby={titleId}
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
      className="space-y-[18px]"
    >
      <h2 id={titleId} className="display-xs m-0">
        Send feedback
      </h2>
      {/* What it's about, as a segmented control: the choice lifts out of the track. */}
      <fieldset className="m-0 border-0 p-0">
        <legend className="sr-only">What&apos;s it about?</legend>
        <div className="inline-flex flex-wrap gap-[4px] rounded-card bg-surface p-[4px]">
          {KINDS.map((k) => (
            <label
              key={k.id}
              className={cn(
                "cursor-pointer rounded-[6px] px-[14px] py-[8px] text-[15px] text-inkBody transition-colors duration-fast has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent",
                kind === k.id ? "bg-white text-ink shadow-card" : "hover:text-ink",
              )}
            >
              <input
                type="radio"
                name="cas-feedback-kind"
                value={k.id}
                checked={kind === k.id}
                onChange={() => setKind(k.id)}
                className="sr-only"
              />
              {k.label}
            </label>
          ))}
        </div>
      </fieldset>

      {kind === "wrong_answer" ? (
        <>
          {typed ? (
            <>
              <Field label="What you entered">
                <Input value={input} onChange={(e) => setInput(e.target.value)} maxLength={2000} required />
              </Field>
              <Field label="What it gave">
                <Input value={output} onChange={(e) => setOutput(e.target.value)} maxLength={4000} />
              </Field>
            </>
          ) : (
            <Field label="Entry">
              <Select value={pick} onChange={(e) => setPick(Number(e.target.value))}>
                {entries
                  .map((h, i) => (
                    <option key={h.id} value={i}>
                      {clip(`${h.inputText}  →  ${said(h)}`, 90)}
                    </option>
                  ))
                  .reverse()}
              </Select>
            </Field>
          )}
          <Field label="What should it be? (optional)">
            <Textarea value={expected} onChange={(e) => setExpected(e.target.value)} maxLength={1000} className="min-h-[64px]" />
          </Field>
        </>
      ) : (
        <Field label={kind === "bug" ? "What happened?" : "What would make it better?"}>
          <Textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            maxLength={2000}
            required
            className="min-h-[96px]"
          />
        </Field>
      )}

      <p className="m-0 text-sm text-inkMuted">Don&apos;t include personal details.</p>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" disabled={state === "sending"}>
          {state === "sending" ? "Sending" : "Send"}
        </Button>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <span role="status" className="text-sm text-inkMuted">
          {state === "failed" && "Couldn't send that. Try again in a minute."}
          {state === "busy" && "That's a lot of feedback. Try again in an hour."}
        </span>
      </div>
    </form>
  );
}

/**
 * The form in a modal: centred on a desktop, a sheet from the foot of the
 * screen on a phone (as shared/ui/sheet.tsx, without its Done button: the
 * form has Send and Cancel). Escape, a backdrop click or Cancel closes it,
 * and focus goes back to whatever opened it.
 */
export function FeedbackDialog({
  source,
  kind,
  onClose,
}: {
  source: ReportSource;
  kind: Kind | null;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<Element | null>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || dialog.open) return;
    opener.current = document.activeElement;
    dialog.showModal();
    document.documentElement.style.overflow = "hidden";
    return () => {
      document.documentElement.style.overflow = "";
    };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-label="Send feedback"
      onClose={() => {
        document.documentElement.style.overflow = "";
        if (opener.current instanceof HTMLElement) opener.current.focus();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) e.currentTarget.close();
      }}
      className="m-auto w-[min(560px,calc(100vw-32px))] max-h-[min(720px,calc(100dvh-48px))] overflow-y-auto rounded-card border border-hairline bg-white p-[24px] text-ink shadow-lift backdrop:bg-ink/30 max-[600px]:mb-0 max-[600px]:w-full max-[600px]:max-w-none max-[600px]:rounded-none max-[600px]:p-[20px]"
    >
      <ReportForm source={source} initialKind={kind} onClose={() => ref.current?.close()} />
    </dialog>
  );
}
