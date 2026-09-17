import { badRequest, notFound } from "./httpError.js";

/**
 * Resolve the ذمة party for checkout. Employee selection reuses
 * employees.customer_id when present and otherwise leaves customerId null
 * until the authorized sale is posted. Never matches customers by name.
 */
export async function resolveOnAccountParty(db, { customerId, employeeId } = {}) {
  const empId = employeeId ? Number(employeeId) : null;
  const custId = customerId ? Number(customerId) : null;

  if (empId) {
    if (!Number.isInteger(empId) || empId <= 0) {
      throw badRequest("اختر الموظف", "EMPLOYEE_REQUIRED");
    }
    const emp = await db.get(
      "SELECT id, name, active, customer_id FROM employees WHERE id = ?",
      [empId]
    );
    if (!emp) throw notFound("الموظف غير موجود", "EMPLOYEE_NOT_FOUND");
    if (!Number(emp.active)) {
      throw badRequest("هذا الموظف غير نشط", "EMPLOYEE_INACTIVE");
    }
    if (custId && emp.customer_id && Number(custId) !== Number(emp.customer_id)) {
      throw badRequest("حساب العميل لا يطابق الموظف المختار", "CUSTOMER_EMPLOYEE_MISMATCH");
    }
    return {
      customerId: emp.customer_id ? Number(emp.customer_id) : null,
      employeeId: Number(emp.id),
      employeeName: emp.name || null,
    };
  }

  if (custId) {
    if (!Number.isInteger(custId) || custId <= 0) {
      throw badRequest("اختر عميلاً للبيع على الذمة", "CUSTOMER_REQUIRED");
    }
    const customer = await db.get("SELECT id, name FROM customers WHERE id = ?", [custId]);
    if (!customer) throw notFound("العميل غير موجود", "NOT_FOUND");
    const linked = await db.get(
      "SELECT id, name FROM employees WHERE customer_id = ?",
      [custId]
    );
    return {
      customerId: Number(customer.id),
      employeeId: linked?.id ? Number(linked.id) : null,
      employeeName: linked?.name || null,
    };
  }

  return { customerId: null, employeeId: null, employeeName: null };
}
