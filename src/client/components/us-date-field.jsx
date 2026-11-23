import React, { useId, useRef, useState } from "react";
import { CalendarDays } from "lucide-react";
import { formatUsDate, parseUsDate } from "../lib/calendar";

export function UsDateField({ label, value, onChange, min, error, required = false }) {
  const id = `date-${useId().replace(/:/g, "")}`;
  const pickerRef = useRef(null);
  const [display, setDisplay] = useState(() => formatUsDate(value));
  const [touched, setTouched] = useState(false);
  const message = error || (touched && display && !parseUsDate(display)
    ? "Enter a valid date as MM/DD/YYYY."
    : "");
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  return (
    <div className="text-sm font-semibold">
      <label htmlFor={id}>{label}{required ? <span aria-hidden="true" className="ml-1 text-red-700">*</span> : null}</label>
      <div className={`relative mt-2 rounded-lg border bg-white focus-within:ring-2 ${message ? "border-red-500 focus-within:ring-red-500" : "focus-within:ring-primary"}`}>
        <input
          id={id}
          aria-label={label}
          aria-invalid={Boolean(message)}
          aria-describedby={message ? errorId : hintId}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          placeholder="MM/DD/YYYY"
          maxLength={10}
          required={required}
          value={display}
          onChange={(event) => {
            const next = event.target.value;
            setDisplay(next);
            onChange(parseUsDate(next));
          }}
          onBlur={() => setTouched(true)}
          className="h-11 w-full rounded-lg bg-transparent px-3 pr-12 outline-none"
        />
        <input
          ref={pickerRef}
          type="date"
          value={value}
          min={min}
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            setDisplay(formatUsDate(event.target.value));
            setTouched(false);
            onChange(event.target.value);
          }}
          className="pointer-events-none absolute inset-y-0 right-0 w-11 opacity-0"
        />
        <button
          type="button"
          aria-label={`Choose ${label.toLowerCase()} date from calendar`}
          onClick={() => {
            if (pickerRef.current?.showPicker) pickerRef.current.showPicker();
            else pickerRef.current?.click();
          }}
          className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-lg focus:outline-none focus:ring-2 focus:ring-primary"
        >
          <CalendarDays size={17} aria-hidden="true" />
        </button>
      </div>
      <p id={hintId} className="sr-only">Enter date as MM/DD/YYYY.</p>
      {message ? <p id={errorId} role="alert" className="mt-1 text-sm font-normal text-red-700">{message}</p> : null}
    </div>
  );
}
