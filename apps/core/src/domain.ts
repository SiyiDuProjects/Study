export const INSTITUTIONS = {
  berkeley: {
    key: "berkeley",
    displayName: "UC Berkeley bCourses",
    baseUrl: "https://bcourses.berkeley.edu",
  },
  hanyang: {
    key: "hanyang",
    displayName: "Hanyang HY-ON",
    baseUrl: "https://learning.hanyang.ac.kr",
  },
} as const;

export type InstitutionKey = keyof typeof INSTITUTIONS;

export function scopesForInstitution(scopes: readonly string[], institution: InstitutionKey): string[] {
  // Legacy clients may still include retired sub-scopes. All current account grants
  // use one permission; school-specific access is enforced by the service itself.
  return scopes.filter(scope => scope === "canvas.read" || scope === "offline_access");
}

export interface CanvasIdentity {
  id: string;
  name: string;
  sortableName?: string;
  loginId?: string;
}

export interface AuthorizedUser {
  id: string;
  displayName: string;
  institution: InstitutionKey;
}

export interface CanvasConnection {
  userId: string;
  institution: InstitutionKey;
  baseUrl: string;
  accessToken: string;
  canvasUserId: string;
  canvasName: string;
}
