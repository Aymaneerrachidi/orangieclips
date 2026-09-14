export const ROLES = {
  owner: { label: 'Owner', allClips: true, reviewClips: true, teamStats: true, manageMembers: true, auditLog: true },
  team: { label: 'Team', allClips: true, reviewClips: true, teamStats: true, manageMembers: false, auditLog: false },
  clipper: { label: 'Clipper', allClips: false, reviewClips: false, teamStats: false, manageMembers: false, auditLog: false },
};
export const permissionsFor = role => ROLES[role] || ROLES.clipper;
export const canReadClip = (user, clip) => permissionsFor(user.role).allClips || clip.user_id === user.id;
export const STATUSES = ['pending', 'approved', 'changes', 'posted', 'not_posting'];
