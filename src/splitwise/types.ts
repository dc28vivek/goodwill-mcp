/**
 * Splitwise API v3.0 types, trimmed to what the connector uses.
 * Source: https://github.com/splitwise/api-docs (splitwise.yaml).
 * Amounts are decimal strings. Dates are ISO 8601 in UTC.
 */

export interface SwUser {
  id: number;
  first_name: string;
  last_name: string | null;
  email?: string;
  registration_status?: 'confirmed' | 'dummy' | 'invited';
}

export interface SwBalance {
  currency_code: string;
  amount: string;
}

export interface SwDebt {
  from: number;
  to: number;
  amount: string;
  currency_code: string;
}

export interface SwGroupMember extends SwUser {
  balance: SwBalance[];
}

export interface SwGroup {
  id: number;
  name: string;
  /** Real accounts return null for groups created before types existed. */
  group_type: 'home' | 'trip' | 'couple' | 'other' | 'apartment' | 'house' | null;
  updated_at: string;
  simplify_by_default: boolean;
  members: SwGroupMember[];
  original_debts: SwDebt[];
  simplified_debts: SwDebt[];
  invite_link?: string;
}

export interface SwFriend extends SwUser {
  groups: { group_id: number; balance: SwBalance[] }[];
  balance: SwBalance[];
  updated_at: string;
}

export interface SwShare {
  user: Pick<SwUser, 'id' | 'first_name' | 'last_name'>;
  user_id: number;
  paid_share: string;
  owed_share: string;
  net_balance: string;
}

export interface SwComment {
  id: number;
  content: string;
  comment_type: 'System' | 'User';
  relation_type: 'ExpenseComment';
  relation_id: number;
  created_at: string;
  deleted_at: string | null;
  user: Pick<SwUser, 'id' | 'first_name' | 'last_name'> | null;
}

export interface SwExpense {
  id: number;
  group_id: number | null;
  friendship_id: number | null;
  description: string;
  details: string | null;
  cost: string;
  currency_code: string;
  date: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  payment: boolean;
  repeats: boolean;
  comments_count?: number;
  category: { id: number; name: string };
  created_by: SwUser | null;
  users: SwShare[];
  repayments: { from: number; to: number; amount: string }[];
  comments?: SwComment[];
}

export interface SwNotification {
  id: number;
  type: number;
  created_at: string;
  created_by: number;
  source: { type: string; id: number; url: string | null } | null;
  content: string;
}

export interface SwCategory {
  id: number;
  name: string;
  subcategories?: SwCategory[];
}

export interface SwCurrency {
  currency_code: string;
  unit: string;
}

export interface SwCurrentUser extends SwUser {
  default_currency: string;
  locale: string;
}

/** Body for POST /create_expense when splitting by shares. */
export interface SwCreateExpenseByShares {
  cost: string;
  description: string;
  group_id: number;
  /**
   * Marks the expense as a settlement rather than a shared cost. Not present
   * in the published OpenAPI schema for create_expense, but accepted by the
   * API and used by Splitwise's own clients. If it were ever ignored, the
   * shares still produce the correct balance; it would just display as an
   * ordinary expense.
   */
  payment?: boolean;
  currency_code?: string;
  category_id?: number;
  date?: string;
  details?: string;
  /** users__{i}__user_id, users__{i}__paid_share, users__{i}__owed_share */
  [key: `users__${number}__${'user_id' | 'paid_share' | 'owed_share'}`]: string | number;
}

/** Body for POST /create_group. Members are flattened like expense shares. */
export interface SwCreateGroup {
  name: string;
  group_type?: 'home' | 'trip' | 'couple' | 'other';
  simplify_by_default?: boolean;
  /** users__{i}__user_id for an existing person, or first_name/last_name/email to invite one. */
  [key: `users__${number}__${'user_id' | 'first_name' | 'last_name' | 'email'}`]: string | number | undefined;
}

/** Body for POST /add_user_to_group: either a known user id, or a new invitation. */
export type SwAddUserToGroup =
  | { group_id: number; user_id: number }
  | { group_id: number; first_name: string; last_name: string; email: string };
