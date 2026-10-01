import { DEFAULT_ROLE_PERMISSIONS, type Permission, type Role } from "@003/shared";

export function permissionsFor(role: Role): Permission[] {
  return [...DEFAULT_ROLE_PERMISSIONS[role]];
}
