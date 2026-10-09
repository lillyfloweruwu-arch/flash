param([Parameter(Mandatory=$true)][string]$Fixture)

# Permit reads and metadata changes, but deny deletion like Media Foundation.
$handle = [System.IO.File]::Open($Fixture, 'Open', 'Read', 'ReadWrite')
try {
    [System.IO.File]::WriteAllText("$Fixture.locked", 'ready')
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    while (-not [System.IO.File]::Exists("$Fixture.release") -and [DateTime]::UtcNow -lt $deadline) {
        Start-Sleep -Milliseconds 20
    }
} finally {
    $handle.Dispose()
}
