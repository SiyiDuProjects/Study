export const INSTITUTIONS = {
  hanyang: {
    key: "hanyang",
    displayName: "Hanyang HY-ON",
    baseUrl: "https://learning.hanyang.ac.kr",
  },
} as const;

export type InstitutionKey = keyof typeof INSTITUTIONS;

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
