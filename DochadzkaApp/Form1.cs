using Dochadzka.Data;
using Dochadzka.Models;
using Dochadzka.Reports;
using Dochadzka.Services;
using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Text;
using System.Windows.Forms;

namespace Dochadzka
{
    public partial class Form1 : Form
    {
        private readonly AttendanceService _service;
        private List<Employee> _employees = new();
        private int _currentYear = DateTime.Now.Year;
        private int _currentMonth = DateTime.Now.Month;

        // Hlavné TabControl
        private TabControl tabMain = new();
        private TabPage tabDochadzka = new() { Text = "📅 Mesačný prehľad" };
        private TabPage tabZamestnanci = new() { Text = "👥 Zamestnanci" };

        // Tab Dochádzka
        private ComboBox cmbEmployee = new();
        private Button btnPrev = new() { Text = "◄ Predošlý" };
        private Button btnNext = new() { Text = "Nasledujúci ►" };
        private Label lblMonth = new();
        private DataGridView dgvDochadzka = new();
        private Button btnSaveRecord = new() { Text = "💾 Uložiť záznam" };
        private Button btnDeleteRecord = new() { Text = "🗑 Vymazať deň" };
        private Button btnExportPdf = new() { Text = "📄 Export PDF" };
        private Button btnExportCsv = new() { Text = "📊 Export CSV" };
        private ComboBox cmbDayType = new();
        private NumericUpDown numHours = new();
        private TextBox txtNote = new();
        private Label lblStats = new();

        // Tab Zamestnanci
        private DataGridView dgvEmployees = new();
        private TextBox txtFirstName = new();
        private TextBox txtLastName = new();
        private TextBox txtPosition = new();
        private Button btnAddEmp = new() { Text = "➕ Pridať" };
        private Button btnUpdateEmp = new() { Text = "✏️ Upraviť" };
        private Button btnDeleteEmp = new() { Text = "🗑 Vymazať" };

        public Form1()
        {
            _service = new AttendanceService();
            InitializeComponent();
            _service.InitializeDatabase();
            BuildUI();
            LoadEmployees();
            LoadDochadzka();
        }

        private void BuildUI()
        {
            this.Text = "Evidencia Dochádzky – DKT s.r.o";
            this.Size = new Size(1100, 700);
            this.StartPosition = FormStartPosition.CenterScreen;
            this.BackColor = Color.FromArgb(245, 247, 250);

            tabMain.Dock = DockStyle.Fill;
            tabMain.Font = new Font("Segoe UI", 10f);
            tabMain.Controls.Add(tabDochadzka);
            tabMain.Controls.Add(tabZamestnanci);
            this.Controls.Add(tabMain);

            BuildDochadzkaTab();
            BuildZamestnanciTab();
        }

        private void BuildDochadzkaTab()
        {
            tabDochadzka.Padding = new Padding(10);

            // Horný panel
            var pnlTop = new Panel { Dock = DockStyle.Top, Height = 60, Padding = new Padding(5) };

            var lblEmp = new Label { Text = "Zamestnanec:", Location = new Point(5, 18), AutoSize = true };
            cmbEmployee.Location = new Point(110, 15);
            cmbEmployee.Width = 200;
            cmbEmployee.DropDownStyle = ComboBoxStyle.DropDownList;
            cmbEmployee.SelectedIndexChanged += (s, e) => LoadDochadzka();

            btnPrev.Location = new Point(330, 13);
            btnPrev.Size = new Size(100, 30);
            btnPrev.BackColor = Color.FromArgb(99, 102, 241);
            btnPrev.ForeColor = Color.White;
            btnPrev.FlatStyle = FlatStyle.Flat;
            btnPrev.Click += (s, e) => { ChangeMonth(-1); };

            lblMonth.Location = new Point(445, 18);
            lblMonth.Width = 150;
            lblMonth.Font = new Font("Segoe UI", 11f, FontStyle.Bold);
            lblMonth.TextAlign = ContentAlignment.MiddleCenter;

            btnNext.Location = new Point(610, 13);
            btnNext.Size = new Size(130, 30);
            btnNext.BackColor = Color.FromArgb(99, 102, 241);
            btnNext.ForeColor = Color.White;
            btnNext.FlatStyle = FlatStyle.Flat;
            btnNext.Click += (s, e) => { ChangeMonth(1); };

            btnExportPdf.Location = new Point(760, 13);
            btnExportPdf.Size = new Size(120, 30);
            btnExportPdf.BackColor = Color.FromArgb(220, 38, 38);
            btnExportPdf.ForeColor = Color.White;
            btnExportPdf.FlatStyle = FlatStyle.Flat;
            btnExportPdf.Click += BtnExportPdf_Click;

            btnExportCsv.Location = new Point(890, 13);
            btnExportCsv.Size = new Size(120, 30);
            btnExportCsv.BackColor = Color.FromArgb(5, 150, 105);
            btnExportCsv.ForeColor = Color.White;
            btnExportCsv.FlatStyle = FlatStyle.Flat;
            btnExportCsv.Click += BtnExportCsv_Click;

            pnlTop.Controls.AddRange(new Control[] { lblEmp, cmbEmployee, btnPrev, lblMonth, btnNext, btnExportPdf, btnExportCsv });
            tabDochadzka.Controls.Add(pnlTop);

            // Grid
            dgvDochadzka.Dock = DockStyle.Fill;
            dgvDochadzka.AllowUserToAddRows = false;
            dgvDochadzka.ReadOnly = true;
            dgvDochadzka.SelectionMode = DataGridViewSelectionMode.FullRowSelect;
            dgvDochadzka.AutoSizeColumnsMode = DataGridViewAutoSizeColumnsMode.AllCells;
            dgvDochadzka.BackgroundColor = Color.White;
            dgvDochadzka.BorderStyle = BorderStyle.None;
            dgvDochadzka.RowHeadersVisible = false;
            dgvDochadzka.Font = new Font("Segoe UI", 9f);
            dgvDochadzka.CellClick += DgvDochadzka_CellClick;
            tabDochadzka.Controls.Add(dgvDochadzka);

            // Spodný panel – záznam
            var pnlBottom = new Panel { Dock = DockStyle.Bottom, Height = 80, BackColor = Color.FromArgb(238, 242, 255), Padding = new Padding(5) };

            var lblDayType = new Label { Text = "Typ dňa:", Location = new Point(5, 25), AutoSize = true };
            cmbDayType.Location = new Point(75, 22);
            cmbDayType.Width = 130;
            cmbDayType.DropDownStyle = ComboBoxStyle.DropDownList;
            cmbDayType.Items.AddRange(new object[] { "P – Pracovný deň", "D – Dovolenka", "0.5D – Pol dňa dovolenky", "PN – Práceneschopnosť", "O – OČR", "L – Lekár", "I – Iné" });
            cmbDayType.SelectedIndex = 0;

            var lblHours = new Label { Text = "Hodiny:", Location = new Point(220, 25), AutoSize = true };
            numHours.Location = new Point(280, 22);
            numHours.Width = 70;
            numHours.DecimalPlaces = 1;
            numHours.Minimum = 0;
            numHours.Maximum = 12;
            numHours.Value = 7.5m;
            numHours.Increment = 0.5m;

            var lblNote = new Label { Text = "Poznámka:", Location = new Point(365, 25), AutoSize = true };
            txtNote.Location = new Point(445, 22);
            txtNote.Width = 200;

            btnSaveRecord.Location = new Point(660, 20);
            btnSaveRecord.Size = new Size(130, 32);
            btnSaveRecord.BackColor = Color.FromArgb(99, 102, 241);
            btnSaveRecord.ForeColor = Color.White;
            btnSaveRecord.FlatStyle = FlatStyle.Flat;
            btnSaveRecord.Click += BtnSaveRecord_Click;

            btnDeleteRecord.Location = new Point(800, 20);
            btnDeleteRecord.Size = new Size(130, 32);
            btnDeleteRecord.BackColor = Color.FromArgb(239, 68, 68);
            btnDeleteRecord.ForeColor = Color.White;
            btnDeleteRecord.FlatStyle = FlatStyle.Flat;
            btnDeleteRecord.Click += BtnDeleteRecord_Click;

            lblStats.Location = new Point(5, 52);
            lblStats.AutoSize = true;
            lblStats.Font = new Font("Segoe UI", 8f);
            lblStats.ForeColor = Color.FromArgb(75, 85, 99);

            pnlBottom.Controls.AddRange(new Control[] { lblDayType, cmbDayType, lblHours, numHours, lblNote, txtNote, btnSaveRecord, btnDeleteRecord, lblStats });
            tabDochadzka.Controls.Add(pnlBottom);
        }

        private void BuildZamestnanciTab()
        {
            tabZamestnanci.Padding = new Padding(10);

            // Formulár
            var pnlForm = new Panel { Dock = DockStyle.Top, Height = 70, Padding = new Padding(5) };

            var lblFn = new Label { Text = "Meno:", Location = new Point(5, 22), AutoSize = true };
            txtFirstName.Location = new Point(55, 19); txtFirstName.Width = 150;

            var lblLn = new Label { Text = "Priezvisko:", Location = new Point(220, 22), AutoSize = true };
            txtLastName.Location = new Point(300, 19); txtLastName.Width = 150;

            var lblPos = new Label { Text = "Pozícia:", Location = new Point(465, 22), AutoSize = true };
            txtPosition.Location = new Point(530, 19); txtPosition.Width = 150;

            btnAddEmp.Location = new Point(695, 17); btnAddEmp.Size = new Size(100, 30);
            btnAddEmp.BackColor = Color.FromArgb(5, 150, 105); btnAddEmp.ForeColor = Color.White;
            btnAddEmp.FlatStyle = FlatStyle.Flat;
            btnAddEmp.Click += BtnAddEmp_Click;

            btnUpdateEmp.Location = new Point(800, 17); btnUpdateEmp.Size = new Size(100, 30);
            btnUpdateEmp.BackColor = Color.FromArgb(99, 102, 241); btnUpdateEmp.ForeColor = Color.White;
            btnUpdateEmp.FlatStyle = FlatStyle.Flat;
            btnUpdateEmp.Click += BtnUpdateEmp_Click;

            btnDeleteEmp.Location = new Point(905, 17); btnDeleteEmp.Size = new Size(100, 30);
            btnDeleteEmp.BackColor = Color.FromArgb(239, 68, 68); btnDeleteEmp.ForeColor = Color.White;
            btnDeleteEmp.FlatStyle = FlatStyle.Flat;
            btnDeleteEmp.Click += BtnDeleteEmp_Click;

            pnlForm.Controls.AddRange(new Control[] { lblFn, txtFirstName, lblLn, txtLastName, lblPos, txtPosition, btnAddEmp, btnUpdateEmp, btnDeleteEmp });
            tabZamestnanci.Controls.Add(pnlForm);

            // Grid
            dgvEmployees.Dock = DockStyle.Fill;
            dgvEmployees.AllowUserToAddRows = false;
            dgvEmployees.ReadOnly = true;
            dgvEmployees.SelectionMode = DataGridViewSelectionMode.FullRowSelect;
            dgvEmployees.AutoSizeColumnsMode = DataGridViewAutoSizeColumnsMode.Fill;
            dgvEmployees.BackgroundColor = Color.White;
            dgvEmployees.BorderStyle = BorderStyle.None;
            dgvEmployees.RowHeadersVisible = false;
            dgvEmployees.Font = new Font("Segoe UI", 10f);
            dgvEmployees.CellClick += DgvEmployees_CellClick;
            tabZamestnanci.Controls.Add(dgvEmployees);
        }

        // --- Logika ---

        private void LoadEmployees()
        {
            _employees = _service.GetAllEmployees();
            cmbEmployee.DataSource = null;
            cmbEmployee.DataSource = _employees;
            cmbEmployee.DisplayMember = "FullName";
            cmbEmployee.ValueMember = "Id";

            dgvEmployees.DataSource = null;
            dgvEmployees.DataSource = _employees.Select(e => new { e.Id, e.FullName, e.Position }).ToList();
            if (dgvEmployees.Columns.Count > 0) dgvEmployees.Columns[0].Visible = false;
        }

        private void LoadDochadzka()
        {
            lblMonth.Text = new DateTime(_currentYear, _currentMonth, 1).ToString("MMMM yyyy");

            if (_employees.Count == 0 || cmbEmployee.SelectedItem == null)
            {
                dgvDochadzka.DataSource = null;
                return;
            }

            var emp = (Employee)cmbEmployee.SelectedItem;
            var records = _service.GetMonthlyRecords(emp.Id, _currentYear, _currentMonth);
            int daysInMonth = DateTime.DaysInMonth(_currentYear, _currentMonth);

            var rows = new List<DayRow>();
            for (int d = 1; d <= daysInMonth; d++)
            {
                var dt = new DateTime(_currentYear, _currentMonth, d);
                var rec = records.FirstOrDefault(r => r.Date.Day == d);
                bool isWeekend = dt.DayOfWeek == DayOfWeek.Saturday || dt.DayOfWeek == DayOfWeek.Sunday;

                rows.Add(new DayRow
                {
                    Deň = d,
                    DenTyzdna = dt.ToString("ddd"),
                    Typ = rec?.DayType ?? (isWeekend ? "–" : ""),
                    Hodiny = rec != null ? rec.Hours.ToString("0.#") : (isWeekend ? "–" : ""),
                    Poznámka = rec?.Note ?? ""
                });
            }

            dgvDochadzka.DataSource = rows;

            // Farby
            for (int i = 0; i < dgvDochadzka.Rows.Count; i++)
            {
                var dt = new DateTime(_currentYear, _currentMonth, i + 1);
                if (dt.DayOfWeek == DayOfWeek.Saturday || dt.DayOfWeek == DayOfWeek.Sunday)
                    dgvDochadzka.Rows[i].DefaultCellStyle.BackColor = Color.FromArgb(229, 231, 235);

                string typ = dgvDochadzka.Rows[i].Cells["Typ"].Value?.ToString() ?? "";
                if (typ == "P") dgvDochadzka.Rows[i].DefaultCellStyle.BackColor = Color.FromArgb(209, 250, 229);
                else if (typ == "D" || typ == "0.5D") dgvDochadzka.Rows[i].DefaultCellStyle.BackColor = Color.FromArgb(254, 243, 199);
                else if (typ == "PN") dgvDochadzka.Rows[i].DefaultCellStyle.BackColor = Color.FromArgb(254, 226, 226);
                else if (typ == "O") dgvDochadzka.Rows[i].DefaultCellStyle.BackColor = Color.FromArgb(237, 233, 254);
                else if (typ == "L") dgvDochadzka.Rows[i].DefaultCellStyle.BackColor = Color.FromArgb(219, 234, 254);
            }

            // Štatistiky
            var stats = _service.GetMonthlyStats(emp.Id, _currentYear, _currentMonth);
            lblStats.Text = $"Pracovné hodiny: {stats.pracDni}h  |  Dovolenka: {stats.dovolenka} dní  |  PN: {stats.pn} dní  |  OČR: {stats.ocr} dní  |  Lekár: {stats.lekar} dní";
        }

        private void ChangeMonth(int delta)
        {
            _currentMonth += delta;
            if (_currentMonth > 12) { _currentMonth = 1; _currentYear++; }
            if (_currentMonth < 1) { _currentMonth = 12; _currentYear--; }
            LoadDochadzka();
        }

        private DateTime? _selectedDate;

        private void DgvDochadzka_CellClick(object? sender, DataGridViewCellEventArgs e)
        {
            if (e.RowIndex < 0) return;
            int day = e.RowIndex + 1;
            _selectedDate = new DateTime(_currentYear, _currentMonth, day);

            if (_employees.Count == 0 || cmbEmployee.SelectedItem == null) return;
            var emp = (Employee)cmbEmployee.SelectedItem;
            var records = _service.GetMonthlyRecords(emp.Id, _currentYear, _currentMonth);
            var rec = records.FirstOrDefault(r => r.Date.Day == day);

            if (rec != null)
            {
                string typCode = rec.DayType;
                int idx = typCode switch { "P" => 0, "D" => 1, "0.5D" => 2, "PN" => 3, "O" => 4, "L" => 5, _ => 6 };
                cmbDayType.SelectedIndex = idx;
                numHours.Value = (decimal)rec.Hours;
                txtNote.Text = rec.Note ?? "";
            }
            else
            {
                cmbDayType.SelectedIndex = 0;
                numHours.Value = 7.5m;
                txtNote.Text = "";
            }
        }

        private void BtnSaveRecord_Click(object? sender, EventArgs e)
        {
            if (_selectedDate == null || cmbEmployee.SelectedItem == null) { MessageBox.Show("Vyberte zamestnanca a deň."); return; }
            var emp = (Employee)cmbEmployee.SelectedItem;
            string[] typCodes = { "P", "D", "0.5D", "PN", "O", "L", "I" };
            string dayType = typCodes[cmbDayType.SelectedIndex];
            _service.SaveRecord(emp.Id, _selectedDate.Value, dayType, (double)numHours.Value, txtNote.Text);
            LoadDochadzka();
        }

        private void BtnDeleteRecord_Click(object? sender, EventArgs e)
        {
            if (_selectedDate == null || cmbEmployee.SelectedItem == null) return;
            var emp = (Employee)cmbEmployee.SelectedItem;
            _service.DeleteRecord(emp.Id, _selectedDate.Value);
            LoadDochadzka();
        }

        private void BtnExportPdf_Click(object? sender, EventArgs e)
        {
            using var dlg = new SaveFileDialog { Filter = "PDF|*.pdf", FileName = $"Dochadzka_{_currentYear}_{_currentMonth:D2}.pdf" };
            if (dlg.ShowDialog() != DialogResult.OK) return;
            var allRecords = _service.GetAllMonthlyRecords(_currentYear, _currentMonth);
            var reportEmployees = _service.GetEmployeesForMonth(_currentYear, _currentMonth);
            PdfGenerator.GenerateMonthlyReport(reportEmployees, allRecords, _currentYear, _currentMonth, dlg.FileName);
            MessageBox.Show("PDF vygenerované!", "Hotovo", MessageBoxButtons.OK, MessageBoxIcon.Information);
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(dlg.FileName) { UseShellExecute = true });
        }

        private void BtnExportCsv_Click(object? sender, EventArgs e)
        {
            using var dlg = new SaveFileDialog { Filter = "CSV|*.csv", FileName = $"Dochadzka_{_currentYear}_{_currentMonth:D2}.csv" };
            if (dlg.ShowDialog() != DialogResult.OK) return;
            var allRecords = _service.GetAllMonthlyRecords(_currentYear, _currentMonth);
            int daysInMonth = DateTime.DaysInMonth(_currentYear, _currentMonth);
            var sb = new StringBuilder();
            sb.Append("Zamestnanec,Pozícia");
            for (int d = 1; d <= daysInMonth; d++) sb.Append($",{d}");
            sb.AppendLine(",Spolu hodín,Dovolenka,PN");
            foreach (var emp in _service.GetEmployeesForMonth(_currentYear, _currentMonth))
            {
                var recs = allRecords.Where(r => r.EmployeeId == emp.Id).ToList();
                sb.Append($"{emp.FullName},{emp.Position}");
                double total = 0, dov = 0;
                int pn = 0;
                for (int d = 1; d <= daysInMonth; d++)
                {
                    var rec = recs.FirstOrDefault(r => r.Date.Day == d);
                    if (rec != null) { sb.Append($",{rec.DayType}"); if (rec.DayType == "P") total += rec.Hours; if (rec.DayType == "D") dov++; if (rec.DayType == "0.5D") dov += 0.5; if (rec.DayType == "PN") pn++; }
                    else sb.Append(",");
                }
                sb.AppendLine($",{total},{dov},{pn}");
            }
            File.WriteAllText(dlg.FileName, sb.ToString(), Encoding.UTF8);
            MessageBox.Show("CSV export dokončený!", "Hotovo", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }

        // --- Zamestnanci ---
        private void DgvEmployees_CellClick(object? sender, DataGridViewCellEventArgs e)
        {
            if (e.RowIndex < 0) return;
            var emp = _employees[e.RowIndex];
            txtFirstName.Text = emp.FirstName;
            txtLastName.Text = emp.LastName;
            txtPosition.Text = emp.Position;
        }

        private void BtnAddEmp_Click(object? sender, EventArgs e)
        {
            if (string.IsNullOrWhiteSpace(txtFirstName.Text) || string.IsNullOrWhiteSpace(txtLastName.Text)) { MessageBox.Show("Vyplňte meno a priezvisko."); return; }
            _service.AddEmployee(txtFirstName.Text.Trim(), txtLastName.Text.Trim(), txtPosition.Text.Trim());
            ClearEmpForm(); LoadEmployees(); LoadDochadzka();
        }

        private void BtnUpdateEmp_Click(object? sender, EventArgs e)
        {
            if (dgvEmployees.SelectedRows.Count == 0) return;
            var emp = _employees[dgvEmployees.SelectedRows[0].Index];
            _service.UpdateEmployee(emp.Id, txtFirstName.Text.Trim(), txtLastName.Text.Trim(), txtPosition.Text.Trim());
            ClearEmpForm(); LoadEmployees(); LoadDochadzka();
        }

        private void BtnDeleteEmp_Click(object? sender, EventArgs e)
        {
            if (dgvEmployees.SelectedRows.Count == 0) return;
            if (MessageBox.Show("Naozaj vymazať zamestnanca?", "Potvrdenie", MessageBoxButtons.YesNo) != DialogResult.Yes) return;
            var emp = _employees[dgvEmployees.SelectedRows[0].Index];
            _service.DeleteEmployee(emp.Id);
            ClearEmpForm(); LoadEmployees(); LoadDochadzka();
        }

        private void ClearEmpForm()
        {
            txtFirstName.Text = ""; txtLastName.Text = ""; txtPosition.Text = "";
        }

        private sealed class DayRow
        {
            public int Deň { get; init; }
            public string DenTyzdna { get; init; } = "";
            public string Typ { get; init; } = "";
            public string Hodiny { get; init; } = "";
            public string Poznámka { get; init; } = "";
        }
    }
}
