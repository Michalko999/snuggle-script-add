using Dochadzka.Models;
using QuestPDF.Fluent;
using QuestPDF.Helpers;
using QuestPDF.Infrastructure;
using System;
using System.Collections.Generic;
using System.Linq;

namespace Dochadzka.Reports
{
    public class PdfGenerator
    {
        public static void GenerateMonthlyReport(
            List<Employee> employees,
            List<AttendanceRecord> records,
            int year, int month,
            string filePath,
            string companyName = "DKT s.r.o")
        {
            QuestPDF.Settings.License = LicenseType.Community;

            int daysInMonth = DateTime.DaysInMonth(year, month);
            string monthName = new DateTime(year, month, 1).ToString("MMMM yyyy");

            Document.Create(container =>
            {
                container.Page(page =>
                {
                    page.Size(PageSizes.A4.Landscape());
                    page.Margin(1, Unit.Centimetre);
                    page.DefaultTextStyle(x => x.FontSize(8));

                    page.Header().Column(col =>
                    {
                        col.Item().Text(companyName).FontSize(14).Bold();
                        col.Item().Text($"Mesačný prehľad dochádzky – {monthName}").FontSize(11);
                        col.Item().PaddingBottom(5).Text($"Vygenerované: {DateTime.Now:dd.MM.yyyy HH:mm}").FontSize(7).FontColor(Colors.Grey.Medium);
                    });

                    page.Content().Table(table =>
                    {
                        // Stĺpce
                        table.ColumnsDefinition(cols =>
                        {
                            cols.RelativeColumn(3); // Meno
                            for (int d = 1; d <= daysInMonth; d++)
                                cols.RelativeColumn(1);
                            cols.RelativeColumn(2); // Hodiny
                            cols.RelativeColumn(2); // Dovolenka
                            cols.RelativeColumn(2); // PN
                        });

                        // Hlavička
                        table.Header(header =>
                        {
                            header.Cell().Background(Colors.Blue.Darken3).Text("Zamestnanec").FontColor(Colors.White).Bold();
                            for (int d = 1; d <= daysInMonth; d++)
                            {
                                var dt = new DateTime(year, month, d);
                                bool isWeekend = dt.DayOfWeek == DayOfWeek.Saturday || dt.DayOfWeek == DayOfWeek.Sunday;
                                string dayLabel = $"{d}\n{dt.ToString("ddd").Substring(0, 2)}";
                                header.Cell()
                                    .Background(isWeekend ? Colors.Grey.Medium : Colors.Blue.Darken3)
                                    .AlignCenter()
                                    .Text(dayLabel).FontColor(Colors.White).FontSize(6);
                            }
                            header.Cell().Background(Colors.Blue.Darken3).AlignCenter().Text("Hod.").FontColor(Colors.White).Bold();
                            header.Cell().Background(Colors.Blue.Darken3).AlignCenter().Text("Dov.").FontColor(Colors.White).Bold();
                            header.Cell().Background(Colors.Blue.Darken3).AlignCenter().Text("PN").FontColor(Colors.White).Bold();
                        });

                        // Riadky
                        foreach (var emp in employees)
                        {
                            var empRecords = records.Where(r => r.EmployeeId == emp.Id).ToList();

                            table.Cell().BorderBottom(0.5f).Text(emp.FullName);

                            double totalHours = 0;
                            double dovDays = 0;
                            int pnDays = 0;

                            for (int d = 1; d <= daysInMonth; d++)
                            {
                                var dt = new DateTime(year, month, d);
                                bool isWeekend = dt.DayOfWeek == DayOfWeek.Saturday || dt.DayOfWeek == DayOfWeek.Sunday;
                                var rec = empRecords.FirstOrDefault(r => r.Date.Day == d);

                                string cellText = "–";
                                string bgColor = isWeekend ? Colors.Grey.Lighten3 : Colors.White;

                                if (rec != null)
                                {
                                    switch (rec.DayType)
                                    {
                                        case "P": cellText = rec.Hours.ToString("0.#"); totalHours += rec.Hours; bgColor = Colors.Green.Lighten4; break;
                                        case "D": cellText = "D"; dovDays++; bgColor = Colors.Orange.Lighten3; break;
                                        case "0.5D": cellText = "½D"; dovDays += 0.5; bgColor = Colors.Orange.Lighten3; break;
                                        case "PN": cellText = "PN"; pnDays++; bgColor = Colors.Red.Lighten3; break;
                                        case "O": cellText = "O"; bgColor = Colors.Purple.Lighten3; break;
                                        case "L": cellText = "L"; bgColor = Colors.Blue.Lighten3; break;
                                        default: cellText = rec.DayType; break;
                                    }
                                }

                                table.Cell().Background(bgColor).BorderBottom(0.5f).AlignCenter().Text(cellText).FontSize(7);
                            }

                            table.Cell().BorderBottom(0.5f).AlignCenter().Text(totalHours.ToString("0.#")).Bold();
                            table.Cell().BorderBottom(0.5f).AlignCenter().Text(dovDays > 0 ? dovDays.ToString("0.#") : "–");
                            table.Cell().BorderBottom(0.5f).AlignCenter().Text(pnDays > 0 ? pnDays.ToString() : "–");
                        }
                    });

                    page.Footer().Row(row =>
                    {
                        row.RelativeItem().Text($"© {companyName}").FontSize(7).FontColor(Colors.Grey.Medium);
                        row.RelativeItem().AlignRight().Text(x =>
                        {
                            x.Span("Strana ").FontSize(7);
                            x.CurrentPageNumber().FontSize(7);
                            x.Span(" / ").FontSize(7);
                            x.TotalPages().FontSize(7);
                        });
                    });
                });
            }).GeneratePdf(filePath);
        }
    }
}
