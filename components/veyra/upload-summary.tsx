import type { MediaRejection } from "@/lib/uploads";

export type UploadFeedback = { saved: string[]; rejected: MediaRejection[] };

export function UploadSummary({ feedback }: { feedback: UploadFeedback | null }) {
  if (!feedback?.rejected.length && !feedback?.saved.length) return null;
  return (
    <div className="upload-summary" aria-live="polite">
      {feedback.saved.length > 0 && <>
        <strong>Saved</strong>
        <ul>{feedback.saved.map((name, index) => <li key={index}>{name}</li>)}</ul>
      </>}
      {feedback.rejected.length > 0 && <>
        <strong>Could not send</strong>
        <ul>{feedback.rejected.map(({ filename, reason }, index) => <li key={index}>{filename} — {reason}</li>)}</ul>
      </>}
    </div>
  );
}
