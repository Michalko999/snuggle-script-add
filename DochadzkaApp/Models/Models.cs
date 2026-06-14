using System;
using System.Collections.Generic;

namespace Dochadzka.Models
{
    public class Employee
    {
        public int Id { get; set; }
        public string FirstName { get; set; } = "";
        public string LastName { get; set; } = "";
        public string Position { get; set; } = "";
        public bool IsActive { get; set; } = true;
        public virtual ICollection<AttendanceRecord> AttendanceRecords { get; set; } = new List<AttendanceRecord>();
        public string FullName => $"{LastName} {FirstName}";
    }

    public class AttendanceRecord
    {
        public int Id { get; set; }
        public int EmployeeId { get; set; }
        public DateTime Date { get; set; }
        public string DayType { get; set; } = "P"; // P=Práca, D=Dovolenka, PN=PN, O=OČR, L=Lekár, I=Iné
        public double Hours { get; set; } = 7.5;
        public string? Note { get; set; }
        public virtual Employee? Employee { get; set; }
    }
}
