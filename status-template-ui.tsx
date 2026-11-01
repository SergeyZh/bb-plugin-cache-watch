import type { StatusTextPart } from './status-template';

export function StatusTemplateText({ parts, monoClassName = '' }: { parts: StatusTextPart[]; monoClassName?: string }) {
  return <>{parts.map((part, index) => part.mono
    ? <span key={index} className={`font-mono tabular-nums whitespace-nowrap ${monoClassName}`}>{part.text}</span>
    : part.text)}</>;
}
