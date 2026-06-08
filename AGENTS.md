# Gongzi Project Rules

These rules are part of the repository and apply to AI coding agents and human maintainers working on this project.

Project paths:

- Repo root: `E:\工资系统\gongzi`
- App root: `E:\工资系统\gongzi\app`
- Default import monitor folder: `D:\laojiu\工资导入`

## General

1. Preserve the existing business workflow unless the user explicitly changes the business decision.
2. Do not silently replace the salary workbook source mode with integrated payroll tables.
   - `salary-workbook` and `integrated` are both long-term modes.
   - The salary workbook remains the default mode unless the user explicitly approves a change.
3. Persist and display `dataSourceMode` consistently in backend input, saved runs, history, and generated output.
4. Enforce current-month-only processing in both renderer and main-process/backend paths when this business rule applies.
5. Preserve user-refined Chinese labels and history table column order unless the user asks for a wording or layout change.

## Salary Import Rules

These rules are critical. Do not undo them during refactors.

1. Keep the import monitor folder at `D:\laojiu\工资导入`.
   - It is used for both direct salary detail imports and monthly payroll source files.
   - Do not change the default to `D:\laojiu\gzdata\工资导入`.
2. Classify salary-related spreadsheets by workbook content, not by file name.
   - File names may be used for display, logging, archive names, or user messages only.
   - Do not decide `工资表`, `专项处理文件`, `在职工资`, `退休工资`, or `其他工资` from words in the file name.
   - Use worksheet names, header rows, and data-column meaning.
3. Monthly payroll source files are reserved for special processing only when their content matches the source format.
   - Salary source workbook examples include columns such as `身份证号`, `姓名`, `岗位工资`, `薪级工资`, and `实发工资合计`.
   - Tax source workbook examples include columns such as `证件号码`, `税款所属期起`, `税款所属期止`, and tax amount fields.
   - Social-security source workbook examples include columns such as `费款所属期起`, `费款所属期止`, `征收项目`, `征收品目`, and amount fields.
   - Known names such as `512扎下小学.xlsx`, `202605_税款计算_工资薪金所得.xls`, and `社保费未申报汇总信息.xls` are regression examples, not name-matching rules.
4. Integrated salary detail workbooks must import directly into the local database when their content matches direct-import tables.
   - Direct-import targets include `在职工资`, `退休工资`, and rows split into `其他工资`.
   - Such workbooks must not be held as monthly special-processing files.
   - Reporting import success with `成功0行` is not a valid business result. Show a clear skip or failure reason unless a workflow explicitly defines empty import as valid.
5. Infer salary detail target sheets from row content and columns.
   - Use fields such as `工资类别名称`, not the workbook file name.
   - `工资类别名称` containing `退休` or `离休` maps to `退休工资`.
   - `工资类别名称` containing `其他`, `遗属`, or `遗补` enters the `退休工资` import path so the split rule can route rows correctly.
   - Other integrated salary detail rows map to `在职工资`.
6. `其他工资` is a split result from `退休工资`.
   - Do not choose `其他工资` by file name.
   - The retirement detail import split currently uses `备注一`: matching non-empty rows route to `其他工资`, and the rest remain `退休工资`.

## Relevant Code

Check these files before changing salary import detection or monthly payroll source behavior:

- `app/src/main/services/excelImportWatcher.ts`
- `app/src/main/services/worksheetInference.ts`
- `app/src/main/services/monthly-payroll/monthlyPayroll.ts`
- `app/src/main/services/monthly-payroll/monthlyPayrollTypes.ts`
- `app/src/main/services/monthly-payroll/monthlyPayrollSources.ts`
- `app/src/main/services/monthly-payroll/monthlyPayrollDataLoaders.ts`
- `app/src/main/services/monthly-payroll/salaryImportWorkbook.ts`
- `app/src/main/services/monthly-payroll/integratedPayroll.ts`
- `app/src/main/services/monthly-payroll/detailImport.ts`

## Validation

After code changes, run project-native checks from `E:\工资系统\gongzi\app`:

```powershell
npm.cmd run typecheck
npm.cmd run build
```

For import-classification changes, add or run regression checks with representative workbook samples:

- monthly salary source workbook
- monthly tax workbook
- monthly social-security workbook
- integrated active salary detail workbook
- integrated retirement salary detail workbook
- retirement detail rows that split into `其他工资`

If the user asks for a packaged installer, or the change affects production-visible packaged behavior, build and verify the installer.
