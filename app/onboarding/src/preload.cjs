const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('ahi',{invoke:async(method,arg)=>{const response=await ipcRenderer.invoke('setup:invoke',method,arg);if(!response.ok)throw Error(response.error);return response.value;}});
