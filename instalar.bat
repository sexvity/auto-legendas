@echo off
setlocal
set "SRC=%~dp0AutoLegendas"
set "D1=%ProgramFiles(x86)%\Common Files\Adobe\CEP\extensions\AutoLegendas"
set "D2=%APPDATA%\Adobe\CEP\extensions\AutoLegendas"

rem Pede permissao de administrador sozinho
net session >nul 2>&1
if errorlevel 1 (
    echo Pedindo permissao de administrador...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

if not exist "%SRC%\CSXS\manifest.xml" goto nosrc

echo.
echo === Auto Legendas - instalador ===
echo.

tasklist /fi "imagename eq AfterFX.exe" 2>nul | find /i "AfterFX.exe" >nul
if not errorlevel 1 (
    echo [aviso] O After Effects esta aberto. Feche-o e rode este instalador de novo.
    pause
    exit /b 1
)

rem Libera extensoes sem assinatura digital (CSXS 9 ate 14)
for %%v in (9 10 11 12 13 14) do reg add "HKCU\Software\Adobe\CSXS.%%v" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul 2>&1

rem Remove versoes antigas e instala nas duas pastas
if exist "%D2%" rmdir /s /q "%D2%"
xcopy "%SRC%" "%D2%\" /e /i /y >nul
echo Instalado em: %D2%

if exist "%D1%" rmdir /s /q "%D1%"
xcopy "%SRC%" "%D1%\" /e /i /y >nul
echo Instalado em: %D1%

goto done

:nosrc
echo Nao achei a pasta AutoLegendas ao lado deste arquivo.
pause
exit /b 1

:done
echo.
echo Pronto! Abra o After Effects.
echo Menu Window ^> Extensions ^> Auto Legendas
echo No fim do painel deve aparecer: Auto Legendas v1.9
echo.
pause
