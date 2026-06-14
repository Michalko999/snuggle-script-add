using Dochadzka.Models;
using Microsoft.EntityFrameworkCore;
using System;
using System.IO;

namespace Dochadzka.Data
{
    public class AttendanceContext : DbContext
    {
        public DbSet<Employee> Employees { get; set; }
        public DbSet<AttendanceRecord> AttendanceRecords { get; set; }

        protected override void OnConfiguring(DbContextOptionsBuilder options)
        {
            string dataDirectory = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "DochadzkaApp");
            Directory.CreateDirectory(dataDirectory);
            options.UseSqlite($"Data Source={Path.Combine(dataDirectory, "data.db")}");
        }

        protected override void OnModelCreating(ModelBuilder modelBuilder)
        {
            modelBuilder.Entity<AttendanceRecord>()
                .HasOne(a => a.Employee)
                .WithMany(e => e.AttendanceRecords)
                .HasForeignKey(a => a.EmployeeId);
        }
    }
}
