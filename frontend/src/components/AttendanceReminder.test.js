import { attendancePageHref, attendanceSurfaceBusy } from "./AttendanceReminder";

describe("attendance reminder helpers", () => {
  test("builds the existing attendance page link with the business date and employees", () => {
    expect(
      attendancePageHref("2026-05-10", [
        { user_id: 4, name: "أ" },
        { user_id: 9, name: "ب" },
      ])
    ).toBe("/employee-attendance?date=2026-05-10&employees=4%2C9");
  });

  test("defers while another modal is open or a field is being edited", () => {
    document.body.innerHTML = `
      <div class="office-content">
        <input id="name" value="" />
      </div>
    `;
    const input = document.getElementById("name");
    input.defaultValue = "";
    input.focus();
    expect(attendanceSurfaceBusy()).toBe(true);

    input.blur();
    expect(attendanceSurfaceBusy()).toBe(false);

    input.value = "سما";
    expect(attendanceSurfaceBusy()).toBe(true);

    input.value = "";
    document.body.innerHTML += `<div class="ui-modal-overlay"><div class="ui-modal"></div></div>`;
    expect(attendanceSurfaceBusy()).toBe(true);

    document.body.innerHTML = `
      <div class="ui-modal-overlay">
        <div class="ui-modal"><div data-attendance-reminder=""></div></div>
      </div>
    `;
    expect(attendanceSurfaceBusy()).toBe(false);
  });
});
