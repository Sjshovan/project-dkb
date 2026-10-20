// Executed only by Windows Script Host; no shell, filesystem writes, or settings changes.
// FileSystemObject's numeric DriveType 2 means a local fixed drive.
try {
  if (WScript.Arguments.length !== 1 || !/^[a-z]:\\$/i.test(WScript.Arguments.Item(0))) WScript.Quit(1);
  var volume = new ActiveXObject('Scripting.FileSystemObject').GetDrive(WScript.Arguments.Item(0));
  WScript.StdOut.WriteLine(volume.DriveType === 2 && volume.IsReady === true && volume.FileSystem === 'NTFS'
    ? 'dkb.windows-storage.v1:supported' : 'dkb.windows-storage.v1:unsupported');
} catch (error) {
  WScript.Quit(1);
}
