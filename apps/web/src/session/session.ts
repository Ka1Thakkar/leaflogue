/** Who is signed in to the hosted library, and how to sign in or out. */
export interface WebSession {
  readonly signedIn: boolean;
  readonly email?: string;
  signIn(): void;
  signOut(): Promise<void>;
}
