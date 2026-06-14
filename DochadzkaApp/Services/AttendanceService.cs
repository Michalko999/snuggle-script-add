using Dochadzka.Data;
using Dochadzka.Models;
using Microsoft.EntityFrameworkCore;
using System;
using System.Collections.Generic;
using System.Linq;

namespace Dochadzka.Services
{
    public class AttendanceService
    {
        public void InitializeDatabase()
        {
            using var db = new AttendanceContext();
            db.Database.EnsureCreated();
        }

        // --- Zamestnanci ---
        public List<Employee> GetAllEmployees()
        {
            using var db = new AttendanceContext();
            return db.Employees.Where(e => e.IsActive).OrderBy(e => e.LastName).ToList();
        }

        public List<Employee> GetEmployeesForMonth(int year, int month)
        {
            using var db = new AttendanceContext();
            return db.Employees
                .Where(e => e.IsActive || e.AttendanceRecords.Any(a => a.Date.Year == year && a.Date.Month == month))
                .OrderBy(e => e.LastName)
                .ThenBy(e => e.FirstName)
                .ToList();
        }

        public void AddEmployee(string firstName, string lastName, string position)
        {
            using var db = new AttendanceContext();
            db.Employees.Add(new Employee
            {
                FirstName = firstName,
                LastName = lastName,
                Position = position,
                IsActive = true
            });
            db.SaveChanges();
        }

        public void UpdateEmployee(int id, string firstName, string lastName, string position)
        {
            using var db = new AttendanceContext();
            var emp = db.Employees.Find(id);
            if (emp != null)
            {
                emp.FirstName = firstName;
                emp.LastName = lastName;
                emp.Position = position;
                db.SaveChanges();
            }
        }

        public void DeleteEmployee(int id)
        {
            using var db = new AttendanceContext();
            var emp = db.Employees.Find(id);
            if (emp != null)
            {
                emp.IsActive = false;
                db.SaveChanges();
            }
        }

        // --- Dochádzka ---
        public List<AttendanceRecord> GetMonthlyRecords(int employeeId, int year, int month)
        {
            using var db = new AttendanceContext();
            return db.AttendanceRecords
                .Where(a => a.EmployeeId == employeeId && a.Date.Year == year && a.Date.Month == month)
                .OrderBy(a => a.Date)
                .ToList();
        }

        public List<AttendanceRecord> GetAllMonthlyRecords(int year, int month)
        {
            using var db = new AttendanceContext();
            return db.AttendanceRecords
                .Include(a => a.Employee)
                .Where(a => a.Date.Year == year && a.Date.Month == month)
                .OrderBy(a => a.Employee == null ? "" : a.Employee.LastName).ThenBy(a => a.Date)
                .ToList();
        }

        public void SaveRecord(int employeeId, DateTime date, string dayType, double hours, string? note)
        {
            using var db = new AttendanceContext();
            var existing = db.AttendanceRecords
                .FirstOrDefault(a => a.EmployeeId == employeeId && a.Date.Date == date.Date);

            if (existing != null)
            {
                existing.DayType = dayType;
                existing.Hours = hours;
                existing.Note = note;
            }
            else
            {
                db.AttendanceRecords.Add(new AttendanceRecord
                {
                    EmployeeId = employeeId,
                    Date = date.Date,
                    DayType = dayType,
                    Hours = hours,
                    Note = note
                });
            }
            db.SaveChanges();
        }

        public void DeleteRecord(int employeeId, DateTime date)
        {
            using var db = new AttendanceContext();
            var record = db.AttendanceRecords
                .FirstOrDefault(a => a.EmployeeId == employeeId && a.Date.Date == date.Date);
            if (record != null)
            {
                db.AttendanceRecords.Remove(record);
                db.SaveChanges();
            }
        }

        // --- Štatistiky ---
        public (double pracDni, double dovolenka, double pn, double ocr, double lekar) GetMonthlyStats(int employeeId, int year, int month)
        {
            var records = GetMonthlyRecords(employeeId, year, month);
            double prac = records.Where(r => r.DayType == "P").Sum(r => r.Hours);
            double dov = records.Sum(r => r.DayType == "D" ? 1.0 : r.DayType == "0.5D" ? 0.5 : 0.0);
            double pn = records.Count(r => r.DayType == "PN");
            double ocr = records.Count(r => r.DayType == "O");
            double lek = records.Count(r => r.DayType == "L");
            return (prac, dov, pn, ocr, lek);
        }
    }
}
