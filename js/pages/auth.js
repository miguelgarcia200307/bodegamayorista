import { supabase } from '../lib/api.js';
import { toast } from '../components/toast.js';
import { $, setButtonLoading } from '../lib/helpers.js';

export async function initLogin() {
  const { data: { session } } = await supabase.auth.getSession();
  if (session && await hasAdminAccess(session.user.id)) { location.replace('index.html'); return; }
  $('#login-form').addEventListener('submit', async event => {
    event.preventDefault(); const button=event.submitter; setButtonLoading(button,true,'Ingresando…');
    const data=new FormData(event.currentTarget);
    try {
      const { data: auth, error }=await supabase.auth.signInWithPassword({email:data.get('email').trim(),password:data.get('password')});
      if(error)throw error;
      if(!await hasAdminAccess(auth.user.id)){await supabase.auth.signOut();toast('Esta cuenta no tiene acceso al administrador.','error');setButtonLoading(button,false);return;}
      location.replace('index.html');
    } catch(error){console.error(error);toast('Correo o contraseña incorrectos.','error');setButtonLoading(button,false);}
  });
  $('#forgot-password').addEventListener('click',async()=>{
    const email=$('#login-form [name="email"]').value.trim();
    if(!email){toast('Escribe primero tu correo electrónico.','error');return;}
    try{const redirectTo=new URL('reset.html',location.href).href;const{error}=await supabase.auth.resetPasswordForEmail(email,{redirectTo});if(error)throw error;toast('Te enviamos un enlace para crear una nueva contraseña.');}catch(error){console.error(error);toast('No pudimos enviar el correo de recuperación.','error');}
  });
}

async function hasAdminAccess(userId){const{data,error}=await supabase.from('admins').select('user_id').eq('user_id',userId).maybeSingle();if(error){console.error(error);return false;}return Boolean(data);}

export async function initReset() {
  $('#reset-form').addEventListener('submit',async event=>{
    event.preventDefault();const button=event.submitter;const data=new FormData(event.currentTarget);const password=data.get('password');
    if(password!==data.get('confirmPassword')){toast('Las contraseñas no coinciden.','error');return;}
    setButtonLoading(button,true,'Guardando…');
    try{const{error}=await supabase.auth.updateUser({password});if(error)throw error;toast('Contraseña actualizada.');setTimeout(()=>location.href='login.html',700);}catch(error){console.error(error);toast('El enlace venció o no es válido. Solicita uno nuevo.','error');setButtonLoading(button,false);}
  });
}

