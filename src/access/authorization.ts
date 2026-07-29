export type StaffRole="OWNER"|"BRANCH_MANAGER"|"ASSISTANT_MANAGER"|"EMPLOYEE";
export type AccessScope="ORGANIZATION"|"BRANCH";
export type Capability=
  |"attendance.self.write"|"attendance.self.read"|"attendance.branch.read"|"attendance.branch.review"|"attendance.branch.correct"
  |"payroll.self.read"|"payroll.branch.read"|"payroll.preview"|"payroll.apply"|"wage.read"|"wage.write"
  |"shift.self.read"|"shift.branch.read"|"shift.branch.write"
  |"expense.submit"|"expense.self.read"|"expense.branch.read"|"expense.branch.review"
  |"staff.self.read"|"staff.self.low_risk_update"|"staff.branch.read"|"staff.branch.create"|"staff.branch.deactivate"|"staff.role.assign"|"staff.owner.assign"
  |"identity.self.link_request"|"identity.approve"|"identity.revoke"|"system.read";

export interface AccessActor{
  employeeId:string;
  role:StaffRole;
  scope:AccessScope;
  branchId:string|null;
  employeeStatus:"ACTIVE"|"INACTIVE";
  roleStatus:"ACTIVE"|"INACTIVE";
}
export interface ResourceScope{branchId?:string|null;employeeId?:string|null;}

const owner=new Set<Capability>([
  "attendance.self.write","attendance.self.read","attendance.branch.read","attendance.branch.review","attendance.branch.correct",
  "payroll.self.read","payroll.branch.read","payroll.preview","payroll.apply","wage.read","wage.write",
  "shift.self.read","shift.branch.read","shift.branch.write","expense.submit","expense.self.read","expense.branch.read","expense.branch.review",
  "staff.self.read","staff.self.low_risk_update","staff.branch.read","staff.branch.create","staff.branch.deactivate","staff.role.assign","staff.owner.assign",
  "identity.self.link_request","identity.approve","identity.revoke","system.read"
]);
const manager=new Set<Capability>([
  "attendance.self.write","attendance.self.read","attendance.branch.read","attendance.branch.review","attendance.branch.correct",
  "payroll.self.read","payroll.branch.read","shift.self.read","shift.branch.read","shift.branch.write",
  "expense.submit","expense.self.read","expense.branch.read","expense.branch.review",
  "staff.self.read","staff.self.low_risk_update","staff.branch.read","staff.branch.create","staff.branch.deactivate","identity.self.link_request"
]);
const assistant=new Set<Capability>([
  "attendance.self.write","attendance.self.read","attendance.branch.read","attendance.branch.review",
  "payroll.self.read","shift.self.read","shift.branch.read","expense.submit","expense.self.read","expense.branch.read",
  "staff.self.read","staff.self.low_risk_update","identity.self.link_request"
]);
const employee=new Set<Capability>([
  "attendance.self.write","attendance.self.read","payroll.self.read","shift.self.read","expense.submit","expense.self.read",
  "staff.self.read","staff.self.low_risk_update","identity.self.link_request"
]);
const grants:Record<StaffRole,Set<Capability>>={OWNER:owner,BRANCH_MANAGER:manager,ASSISTANT_MANAGER:assistant,EMPLOYEE:employee};

export function authorize(actor:AccessActor|null|undefined,capability:Capability,resource:ResourceScope={}):boolean{
  if(!actor||actor.employeeStatus!=="ACTIVE"||actor.roleStatus!=="ACTIVE"||!grants[actor.role].has(capability))return false;
  if(actor.role==="OWNER"&&actor.scope==="ORGANIZATION")return true;
  if(capability.includes(".self."))return !resource.employeeId||resource.employeeId===actor.employeeId;
  if(actor.scope!=="BRANCH"||!actor.branchId)return false;
  return !resource.branchId||resource.branchId===actor.branchId;
}

export function assertAuthorized(actor:AccessActor|null|undefined,capability:Capability,resource:ResourceScope={}):void{
  if(!authorize(actor,capability,resource))throw new Error("FORBIDDEN");
}
