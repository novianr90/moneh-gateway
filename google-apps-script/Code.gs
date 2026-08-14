/**
 * Google Apps Script Web App for TrackerMoneh
 * Receives expenses payload from Supabase Edge Function and appends/inserts them into Google Sheets.
 */

// Define header columns in your target sheet
const SHEET_NAME = 'Expenses';
const API_KEY_SECRET = 'YOUR_SECRET_SPREADSHEET_API_KEY'; // Match SPREADSHEET_API_KEY in Supabase secrets

function doPost(e) {
  try {
    const contents = JSON.parse(e.postData.contents);
    const { apiKey, action, data } = contents;

    // Validate API Key
    if (apiKey !== API_KEY_SECRET) {
      return ContentService.createTextOutput(
        JSON.stringify({ status: 'error', message: 'Unauthorized: Invalid API Key' })
      ).setMimeType(ContentService.MimeType.JSON);
    }

    if (action === 'syncExpenses') {
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      let sheet = ss.getSheetByName(SHEET_NAME);

      // Create sheet and headers if it doesn't exist
      if (!sheet) {
        sheet = ss.insertSheet(SHEET_NAME);
        sheet.appendRow([
          'Transaction ID',
          'Date',
          'Category',
          'Payment Method',
          'Amount (IDR)',
          'Description',
          'User Email',
          'Synced At'
        ]);
        sheet.getRange(1, 1, 1, 8).setFontWeight('bold');
      }

      const rowsToAppend = (data || []).map(item => [
        item.id,
        item.expense_date,
        item.category_name,
        item.payment_method || 'Cash',
        item.amount,
        item.description || '',
        item.user_email || '',
        new Date().toISOString()
      ]);

      if (rowsToAppend.length > 0) {
        const lastRow = sheet.getLastRow();
        sheet.getRange(lastRow + 1, 1, rowsToAppend.length, 8).setValues(rowsToAppend);
      }

      return ContentService.createTextOutput(
        JSON.stringify({
          status: 'success',
          syncedCount: rowsToAppend.length,
          message: `Successfully appended ${rowsToAppend.length} rows.`
        })
      ).setMimeType(ContentService.MimeType.JSON);
    }

    return ContentService.createTextOutput(
      JSON.stringify({ status: 'error', message: `Unknown action: ${action}` })
    ).setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService.createTextOutput(
      JSON.stringify({ status: 'error', message: err.toString() })
    ).setMimeType(ContentService.MimeType.JSON);
  }
}
