"use client";

import React, { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { UNITS } from "@/lib/units";

// A unit box with our own suggestion list. The browser's <datalist> popup
// cannot be styled and showed as a black box over light forms. Any unit can
// still be typed; the list only suggests. Drop-in for <input list="sf-units">:
// onChange receives { target: { value } } so existing handlers keep working.
type Props = Omit<React.InputHTMLAttributes<HTMLInputElement>, "list"> & { value: string };

export default function UnitInput({ value, onChange, onFocus, onBlur, ...rest }: Props) {
  const ref = useRef<HTMLInputElement>(null);
  const [box, setBox] = useState<DOMRect | null>(null);

  const q = (value || "").trim().toLowerCase();
  const matches = UNITS.filter((u) => !q || u.toLowerCase().includes(q));
  const exact = UNITS.some((u) => u.toLowerCase() === q);
  const shown = exact ? UNITS : matches;

  const pick = (u: string) => {
    onChange?.({ target: { value: u } } as React.ChangeEvent<HTMLInputElement>);
    setBox(null);
  };

  return (
    <>
      <input
        {...rest}
        ref={ref}
        value={value}
        autoComplete="off"
        onChange={(e) => {
          onChange?.(e);
          if (ref.current) setBox(ref.current.getBoundingClientRect());
        }}
        onFocus={(e) => {
          setBox(e.currentTarget.getBoundingClientRect());
          onFocus?.(e);
        }}
        onBlur={(e) => {
          setBox(null);
          onBlur?.(e);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") setBox(null);
        }}
      />
      {box && shown.length > 0 && typeof document !== "undefined" &&
        createPortal(
          <ul
            style={{ position: "fixed", top: box.bottom + 4, left: box.left, minWidth: Math.max(box.width, 140), zIndex: 1000 }}
            className="max-h-56 overflow-y-auto rounded-lg border border-border-custom bg-card py-1 text-sm text-foreground shadow-lg"
          >
            {shown.map((u) => (
              <li
                key={u}
                // mousedown, not click, so the pick lands before the input blurs
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(u);
                }}
                className={`cursor-pointer px-3 py-1.5 hover:bg-primary/10 ${u === value ? "font-semibold text-primary" : ""}`}
              >
                {u}
              </li>
            ))}
          </ul>,
          document.body,
        )}
    </>
  );
}
