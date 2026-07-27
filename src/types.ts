export type FeedbackStyle = 'spoken' | 'chime' | 'both';

// A preset: one variant of the math grader (the shipped prompt, or a user-tuned copy).
// Every preset runs the same button-driven pipeline (capture / check / hint / finish);
// what varies is the grading prompt and the feedback delivery.
export interface Mode {
  id: string;
  label: string;
  systemPrompt: string;
  feedbackStyle: FeedbackStyle;
}
