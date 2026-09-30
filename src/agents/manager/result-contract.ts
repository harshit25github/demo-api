export type ManagerToolStatus = 'success' | 'partial' | 'needs_input' | 'failure';

/** Only bounded, user-relevant facts cross the specialist-to-Manager boundary. */
export interface ManagerToolResult {
  status: ManagerToolStatus;
  completedTask?: string;
  summary: string;
  userRelevantData?: Record<string, string | number | boolean | null>;
  presentation?: 'flight_cards' | 'flight_cards_with_price_note';
  renderRef?: string;
  missingInformation?: string[];
  suggestedNextAction?: string;
  recovery?: { code: string; retryable: boolean };
}
