# Evidencia dochádzky

## Spustenie vo Visual Studiu

1. Nainštalujte **Visual Studio 2022** s workloadom **.NET desktop development**.
2. Otvorte súbor `DochadzkaApp.sln`.
3. Počkajte na automatické obnovenie NuGet balíkov.
4. Aplikáciu spustite klávesom **F5**.

Projekt používa .NET 8, Windows Forms, SQLite a QuestPDF. Databáza sa vytvorí automaticky v priečinku `%LOCALAPPDATA%\DochadzkaApp\data.db`, takže aplikácia má právo zapisovať dáta aj po publikovaní do `Program Files`.

## Vytvorenie samostatnej aplikácie

Vo Visual Studiu kliknite pravým tlačidlom na projekt **DochadzkaApp**, zvoľte **Publish**, potom **Folder**. Ako deployment mode môžete vybrať **Self-contained**, aby cieľový počítač nepotreboval samostatnú inštaláciu .NET.